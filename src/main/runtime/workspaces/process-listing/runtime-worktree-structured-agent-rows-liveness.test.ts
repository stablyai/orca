import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { collectRuntimeWorktreeAgentSources } from './runtime-worktree-agent-sources'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StructuredAgentSessionStatusFeed } from '../../../native-chat/agent-session-wire/observations/structured-agent-session-status-feed'
import { createTrackedJournalOpener } from '../../../native-chat/agent-session-journal/store-lifecycle/journal-host-database-test-support'
import type { StatusFeedSession } from '../../../native-chat/agent-session-wire/observations/structured-agent-session-status-feed-deps'
import type { RuntimeWorktreePsSummary } from '../../../../shared/worktree/catalog/runtime-worktree-contracts'
import { AgentHookServer, _internals } from '../../../agent-hooks/server/agent-hook-server'
import { attachRuntimeWorktreeAgentRows } from './runtime-worktree-agent-rows'
import { createStructuredAgentSessionLogger } from '../../../native-chat/agent-session-wire/host/structured-agent-session-logger'
import { codexProviderHandle } from '../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'

vi.mock('../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: vi.fn(() => ({ nth_repo_added: 2 }))
}))

/** Exercise journal to worktree-status liveness: feed summaries never retract, but the store drops closed chats, including unanswered approvals whose retained status stays attention. */
const WORKTREE_ID = 'repo-1::/workspace/app'
const SESSION = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
const IDENTITY = {
  provider: 'codex',
  threadId: 'thread-1',
  turnId: 'turn-1',
  ordinal: 0
} as const

let root: string
const journals = createTrackedJournalOpener()

beforeEach(async () => {
  _internals.resetCachesForTests()
  root = await mkdtemp(join(tmpdir(), 'orca-structured-ps-liveness-'))
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

/** A session parked on an approval nobody answered — the state a deliberate close leaves behind. */
async function awaitingApproval() {
  const journal = await journals.open({
    identity: {
      sessionId: SESSION,
      workspaceId: WORKTREE_ID,
      hostId: 'local',
      agent: 'codex',
      providerHandle: codexProviderHandle('thread-1')
    },
    stateDirectory: join(root, SESSION)
  })
  await journal.appendItem(
    { ...IDENTITY, ordinal: 1 },
    { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'rm the branch' }] },
    { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  await journal.appendItem(
    { ...IDENTITY, ordinal: 2 },
    {
      kind: 'approval',
      title: 'Run the command?',
      detail: null,
      options: [{ id: 'allow', label: 'Allow' }],
      resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
    },
    { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  const session: StatusFeedSession = {
    journal,
    child: { phase: 'ready', generation: 'child-1', fence: 1 },
    params: {
      location: {
        executionHostId: 'local',
        wslDistro: null,
        workspaceId: WORKTREE_ID,
        workspaceKind: 'git-worktree'
      },
      provider: 'codex'
    }
  }
  const store = new AgentHookServer()
  const feed = new StructuredAgentSessionStatusFeed({
    logger: createStructuredAgentSessionLogger(),
    sessions: new Map([[SESSION, session]]),
    getConversation: () => null,
    rowRetired: () => !session.child,
    now: () => Date.now(),
    statusSink: () => ({
      publish: (summary, subject) => store.ingestStructuredStatus(summary, subject),
      forget: (sessionId) => store.dropStructuredStatus(sessionId)
    })
  })
  await feed.publish(SESSION, journal)
  return { feed, session, store }
}

function worktreeFor(store: AgentHookServer): RuntimeWorktreePsSummary {
  const row = {
    worktreeId: WORKTREE_ID,
    status: 'inactive',
    agents: []
  } as unknown as RuntimeWorktreePsSummary
  const summaries = new Map([[WORKTREE_ID, row]])
  attachRuntimeWorktreeAgentRows({
    summaries,
    terminalTitleEvidenceByRow: new Map(),
    rowSources: collectRuntimeWorktreeAgentSources({
      mirroredWorktreeIdByTabId: new Map(),
      connectedPtyEvidence: {
        tabIds: new Set(),
        paneKeys: new Set(),
        ptyIdByTerminalHandle: new Map(),
        terminalHandleByPaneKey: new Map()
      },
      hookSnapshots: store.getStatusSnapshot()
    }),
    orchestrationByPaneKey: null,
    getSummary: (id) => summaries.get(id) ?? null
  })
  return row
}

describe('worktree ps and a closed structured chat', () => {
  it('drops the closed chat and keeps it out after journal replay', async () => {
    const { feed, session, store } = await awaitingApproval()
    expect(worktreeFor(store).agents).toHaveLength(1)

    session.child = null
    feed.close(SESSION)
    expect(worktreeFor(store)).toMatchObject({ agents: [], status: 'inactive' })

    await feed.publish(SESSION, undefined, { replay: true })
    expect(worktreeFor(store)).toMatchObject({ agents: [], status: 'inactive' })
  })
})
