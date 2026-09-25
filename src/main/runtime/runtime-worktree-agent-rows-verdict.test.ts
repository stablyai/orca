import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeStructuredAgentStatusSubject } from '../../shared/agent-status-subject'
import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import type {
  AgentSessionStatusEvent,
  AgentSessionStatusSummary
} from '../../shared/agent-session-wire'
import type { RuntimeWorktreePsSummary } from '../../shared/runtime-types'
import { AgentHookServer, _internals } from '../agent-hooks/server'
import { createTrackedJournalOpener } from '../native-chat/agent-session-journal/journal-store-test-open'
import type { AgentSessionJournal } from '../native-chat/agent-session-journal/journal-store'
import { StructuredAgentSessionStatusFeed } from '../native-chat/agent-session-wire/structured-agent-session-status-feed'
import { indexedStatusFeedSession } from '../native-chat/agent-session-wire/structured-agent-session-status-feed-test-session'
import { attachRuntimeWorktreeAgentRows } from './runtime-worktree-agent-rows'
import { collectRuntimeWorktreeAgentSources } from './runtime-worktree-agent-sources'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: vi.fn(() => ({ nth_repo_added: 2 }))
}))

// A request that failed reads as failed on every surface the host feeds: the journal's verdict
// travels the real feed, the status-store ingest and `worktree ps`, never just the projection.
const SESSION = 'verdict-session'
const WORKSPACE_ID = 'workspace-1'
const SUBJECT = makeStructuredAgentStatusSubject(
  {
    executionHostId: 'local',
    wslDistro: null,
    workspaceId: WORKSPACE_ID,
    workspaceKind: 'git-worktree'
  },
  SESSION
)
const TURN_IDENTITY = {
  provider: 'codex',
  threadId: 'thread-1',
  turnId: 'turn-1',
  ordinal: 0
} as const

let root: string
const journals = createTrackedJournalOpener()

beforeEach(async () => {
  _internals.resetCachesForTests()
  root = await mkdtemp(join(tmpdir(), 'orca-verdict-rows-'))
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

async function openJournal(): Promise<AgentSessionJournal> {
  return journals.open({
    identity: {
      sessionId: SESSION,
      workspaceId: WORKSPACE_ID,
      hostId: 'local',
      agent: 'codex',
      providerHandle: { kind: 'codex', threadId: 'thread-1' }
    },
    journalDir: join(root, SESSION)
  })
}

/** What the host's real feed publishes for this journal. */
function publishedSummary(journal: AgentSessionJournal): AgentSessionStatusSummary {
  const session = indexedStatusFeedSession({ journal })
  const feed = new StructuredAgentSessionStatusFeed({
    sessions: new Map([[SESSION, session]]),
    getRecord: () => agentSessionRecordFixture(),
    now: () => 1_000
  })
  const events: AgentSessionStatusEvent[] = []
  feed.subscribe({ id: 'list', emit: (event) => events.push(event) })
  const snapshot = events.find((event) => event.type === 'snapshot')
  const summary = snapshot?.type === 'snapshot' ? snapshot.sessions[0] : undefined
  if (!summary) {
    throw new Error('the feed published no session')
  }
  return summary
}

function ingest(summary: AgentSessionStatusSummary) {
  const store = new AgentHookServer()
  store.ingestStructuredStatus(summary, SUBJECT)
  const hookSnapshots = store.getStatusSnapshot()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: attaching agent rows reads and writes only `worktreeId`, `status`, `hasHostSidebarActivity` and `agents`.
  const row = {
    worktreeId: WORKSPACE_ID,
    status: 'inactive',
    hasHostSidebarActivity: false,
    agents: []
  } as unknown as RuntimeWorktreePsSummary
  attachRuntimeWorktreeAgentRows({
    summaries: new Map([[WORKSPACE_ID, row]]),
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: `getSummary` below resolves every row by id, so the path index is never read.
    pathIndex: { byPath: new Map(), byRealPath: new Map() } as never,
    missingWorktreeIds: new Set(),
    workingTerminalEvidenceByWorktreeId: new Map(),
    rowSources: collectRuntimeWorktreeAgentSources({
      mirroredWorktreeIdByTabId: new Map(),
      connectedPtyEvidence: {
        tabIds: new Set(),
        paneKeys: new Set(),
        ptyIdByTerminalHandle: new Map()
      },
      hookSnapshots
    }),
    orchestrationByPaneKey: null,
    getSummary: (map, _p, _m, id) => map.get(id) ?? null
  })
  return { status: hookSnapshots[0], ps: row.agents[0] }
}

describe('a request that failed reads as failed through the feed, the ingest and worktree ps', () => {
  it('reads a chat whose only send the agent start refused as failed, not interrupted', async () => {
    const journal = await openJournal()
    await journal.appendSubmission({
      clientMessageId: 'first',
      payloadFingerprint: 'fp',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] },
      fence: 1,
      handoverRecorded: true
    })
    await journal.rejectQueuedSubmissions(1, 'Claude is not signed in.')

    const summary = publishedSummary(journal)
    expect(summary).toMatchObject({ status: 'idle', turnOutcome: 'failure', latestPrompt: 'hello' })
    const { status, ps } = ingest(summary)
    expect(status).toMatchObject({
      state: 'done',
      mainAgent: { state: 'done', outcome: 'failure' }
    })
    expect(status?.interrupted).not.toBe(true)
    expect(ps).toMatchObject({ state: 'done', outcome: 'failure', interrupted: false })
  })

  it('reads a cancelled structured turn as interrupted for readers that predate the verdict', async () => {
    const journal = await openJournal()
    await journal.appendItem(
      TURN_IDENTITY,
      {
        kind: 'turn',
        turnId: 'turn-1',
        state: 'interrupted',
        outcome: 'cancellation',
        completedAt: 5
      },
      { fence: 1 }
    )

    const { status, ps } = ingest(publishedSummary(journal))
    expect(status).toMatchObject({ state: 'done', interrupted: true })
    expect(ps).toMatchObject({ outcome: 'cancellation', interrupted: true })
  })

  it('lists nothing for a chat whose only send the user withdrew', async () => {
    const journal = await openJournal()
    await journal.appendSubmission({
      clientMessageId: 'first',
      payloadFingerprint: 'fp',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] },
      fence: 1,
      handoverRecorded: true
    })
    await journal.rejectQueuedSubmissions(1, 'provider_cancelled_before_start')

    expect(publishedSummary(journal)).toMatchObject({ status: null })
    expect(ingest(publishedSummary(journal)).ps).toBeUndefined()
  })
})
