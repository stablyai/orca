import { collectRuntimeWorktreeAgentSources } from './runtime-worktree-agent-sources'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { StructuredAgentSessionStatusFeed } from '../native-chat/agent-session-wire/structured-agent-session-status-feed'
import { createTrackedJournalOpener } from '../native-chat/agent-session-journal/journal-store-test-open'
import type { RuntimeWorktreePsSummary } from '../../shared/runtime-types'
import { attachRuntimeWorktreeAgentRows } from './runtime-worktree-agent-rows'

/**
 * The whole chain `worktree ps` walks: journal -> status feed -> agent rows -> worktree status.
 *
 * The feed's `published` map never retracts, so reading it as a roster reports every session the
 * app has ever opened. A closed chat that was waiting on an approval is the sharp edge: deliberate
 * close does not settle a pending prompt, so the retained summary stays `attention`, which maps to
 * a `blocked` row and merges the worktree to `permission` for the 30-minute freshness window.
 */
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
      providerHandle: { kind: 'codex', threadId: 'thread-1' }
    },
    journalDir: join(root, SESSION)
  })
  await journal.appendItem(
    { ...IDENTITY, ordinal: 1 },
    { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'rm the branch' }] },
    { fence: 1 }
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
    { fence: 1 }
  )
  const sessions = new Map([
    [
      SESSION,
      { journal, params: { location: { workspaceId: WORKTREE_ID }, provider: 'codex' as const } }
    ]
  ])
  const feed = new StructuredAgentSessionStatusFeed({
    sessions,
    getRecord: () => null,
    now: () => Date.now()
  })
  feed.publish(SESSION, journal)
  return { feed, sessions }
}

function worktreeFor(
  feed: StructuredAgentSessionStatusFeed,
  summaries = feed.liveSessionSummaries()
): RuntimeWorktreePsSummary {
  const row = {
    worktreeId: WORKTREE_ID,
    status: 'inactive',
    agents: []
  } as unknown as RuntimeWorktreePsSummary
  attachRuntimeWorktreeAgentRows({
    summaries: new Map([[WORKTREE_ID, row]]),
    pathIndex: { byPath: new Map(), byRealPath: new Map() } as never,
    missingWorktreeIds: new Set(),
    workingTerminalEvidenceByWorktreeId: new Map(),
    rowSources: collectRuntimeWorktreeAgentSources({
      mirroredWorktreeIdByTabId: new Map(),
      connectedPtyEvidence: { tabIds: new Set(), paneKeys: new Set(), ptyIds: new Set() },
      retainedSnapshots: [],
      hookSnapshots: [],
      structuredSummaries: summaries
    }),
    orchestrationByPaneKey: null,
    getSummary: (map, _paths, _missing, id) => map.get(id) ?? null
  })
  return row
}

describe('worktree ps and a closed structured chat', () => {
  it('reports the blocked row while the session is still held', async () => {
    const { feed } = await awaitingApproval()
    const row = worktreeFor(feed)
    expect(row.agents).toHaveLength(1)
    expect(row.agents[0]?.state).toBe('blocked')
    expect(row.status).toBe('permission')
  })

  it('stops reporting it once eviction forgets the session', async () => {
    const { feed, sessions } = await awaitingApproval()
    // `forget-session`, the last eviction step, does exactly this and nothing to the feed.
    sessions.delete(SESSION)

    const row = worktreeFor(feed)
    expect(row.agents).toHaveLength(0)
    expect(row.status).toBe('inactive')
  })

  it('keeps an aged host-held working state authoritative', async () => {
    const { feed } = await awaitingApproval()
    const aged = feed.liveSessionSummaries().map((summary) => ({
      ...summary,
      hostExecutionOwned: true as const,
      updatedAt: Date.now() - 30 * 60 * 1000 - 1,
      status: 'working' as const
    }))
    const row = worktreeFor(feed, aged)
    expect(row.agents).toHaveLength(1)
    expect(row.agents[0]?.state).toBe('working')
    expect(row.status).toBe('working')
    expect(row.agents[0]?.updatedAt).toBe(aged[0]?.updatedAt)
  })

  it('keeps an aged host-held approval state authoritative', async () => {
    const { feed } = await awaitingApproval()
    const aged = feed.liveSessionSummaries().map((summary) => ({
      ...summary,
      hostExecutionOwned: true as const,
      updatedAt: Date.now() - 30 * 60 * 1000 - 1
    }))
    const row = worktreeFor(feed, aged)
    expect(row.agents).toHaveLength(1)
    expect(row.agents[0]?.state).toBe('blocked')
    expect(row.status).toBe('permission')
    expect(row.agents[0]?.updatedAt).toBe(aged[0]?.updatedAt)
  })
})
