import { collectRuntimeWorktreeAgentSources } from './runtime-worktree-agent-sources'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { attachRuntimeWorktreeAgentRows } from './runtime-worktree-agent-rows'
import { structuredAgentSessionPaneKey } from '../../shared/structured-agent-session-projection'
import type { AgentSessionStatusSummary } from '../../shared/agent-session-wire'
import type { RuntimeWorktreePsSummary } from '../../shared/runtime-types'
import { AgentHookServer, _internals } from '../agent-hooks/server'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: vi.fn(() => ({ nth_repo_added: 2 }))
}))

/**
 * A structured session has no PTY and no hook script, so the host publishes its projection into
 * the agent-status store itself. This walks that store into `worktree ps` rows: before it, the CLI
 * reported a worktree running one as idle while the sidebar showed it working.
 */
const WORKTREE_ID = 'repo-1::/workspace/app'
const SESSION = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'

function summary(over: Partial<AgentSessionStatusSummary> = {}): AgentSessionStatusSummary {
  return {
    sessionId: SESSION,
    workspaceId: WORKTREE_ID,
    agent: 'claude',
    status: 'working',
    latestPrompt: 'ship the thing',
    updatedAt: 1_757_030_400_000,
    hostExecutionOwned: true,
    ...over
  } as AgentSessionStatusSummary
}

function attach(summaries: AgentSessionStatusSummary[]): RuntimeWorktreePsSummary {
  const store = new AgentHookServer()
  for (const entry of summaries) {
    store.ingestStructuredStatus(entry)
  }
  const row = {
    worktreeId: WORKTREE_ID,
    status: 'inactive',
    hasHostSidebarActivity: false,
    agents: []
  } as unknown as RuntimeWorktreePsSummary
  const summariesById = new Map<string, RuntimeWorktreePsSummary>([[WORKTREE_ID, row]])
  attachRuntimeWorktreeAgentRows({
    summaries: summariesById,
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
      hookSnapshots: store.getStatusSnapshot()
    }),
    orchestrationByPaneKey: null,
    getSummary: (map, _p, _m, id) => map.get(id) ?? null
  })
  return row
}

beforeEach(() => {
  _internals.resetCachesForTests()
})

describe('worktree ps reports structured sessions', () => {
  it('a busy structured session is not reported idle', () => {
    const row = attach([summary()])
    expect(row.agents).toHaveLength(1)
    expect(row.agents[0]?.state).toBe('working')
    expect(row.agents[0]?.agentType).toBe('claude')
    expect(row.agents[0]?.prompt).toBe('ship the thing')
    expect(row.status).toBe('working')
  })

  // The same projection the sidebar applies, so the two surfaces cannot disagree about one session.
  it('maps attention to blocked and idle to done', () => {
    expect(attach([summary({ status: 'attention' })]).agents[0]?.state).toBe('blocked')
    expect(attach([summary({ status: 'idle' })]).agents[0]?.state).toBe('done')
  })

  it('does not turn a completed host-held session into permission', () => {
    const row = attach([summary({ status: 'idle' })])
    expect(row.status).toBe('inactive')
    expect(row.hasHostSidebarActivity).toBe(false)
  })

  it('reports the DERIVED pane key, never an orchestration credential', () => {
    const row = attach([summary()])
    expect(row.agents[0]?.paneKey).toBe(structuredAgentSessionPaneKey(SESSION))
  })

  // Null status means no turn has been persisted; the chat itself shows nothing, so neither does this.
  it('omits a session with no projected status', () => {
    expect(attach([summary({ status: null })]).agents).toHaveLength(0)
  })

  it('keeps the journal clock on the row, so a restart republish is not new activity', () => {
    const row = attach([summary()])
    expect(row.agents[0]?.updatedAt).toBe(1_757_030_400_000)
    expect(row.agents[0]?.stateStartedAt).toBe(1_757_030_400_000)
  })
})

/**
 * The deliberate non-goal. Adding structured rows to `terminal list` was investigated and rejected:
 * mobile mounts a terminal WebView per row that can never receive a frame, a `connected`-keyed
 * refresh check goes permanently true and pins shipped clients to a fast cadence with no exit, and
 * the plugin projection has no field that can carry `writable: false`. Every SAFE consumer of a
 * terminal summary checks `ptyId`; the breaking ones key off `connected` or mere row presence,
 * which no added field can qualify. This pins that the listing never reads the status store.
 */
describe('terminal listing is deliberately left alone', () => {
  it('never reads the agent-status store that now carries structured rows', async () => {
    const { readFile } = await import('node:fs/promises')
    // orca-runtime-subscribe-to-terminal-resize.ts owns listTerminals.
    const listing = await readFile(
      new URL('./orca-runtime-subscribe-to-terminal-resize.ts', import.meta.url),
      'utf8'
    )
    // Guard the guard: an empty read would make every assertion below vacuously true.
    expect(listing).toContain('async listTerminals(')
    expect(listing).not.toContain('getAgentStatusSnapshotFn')
    expect(listing).not.toContain('structuredHost')
  })
})
