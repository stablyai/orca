import { collectRuntimeWorktreeAgentSources } from './runtime-worktree-agent-sources'
import { describe, expect, it } from 'vitest'
import { attachRuntimeWorktreeAgentRows } from './runtime-worktree-agent-rows'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../shared/structured-agent-session-projection'
import type { AgentSessionStatusSummary } from '../../shared/agent-session-wire'
import type { RuntimeWorktreePsSummary } from '../../shared/runtime-types'

/**
 * A structured session has no PTY, so it reaches none of the hook or retained snapshots that every
 * other row comes from. Before this, `worktree ps` reported a worktree running one as idle while
 * the sidebar showed it working — the CLI, which is the agent-facing surface, was the blind one.
 */
const WORKTREE_ID = 'repo-1::/workspace/app'

function summary(over: Partial<AgentSessionStatusSummary> = {}): AgentSessionStatusSummary {
  return {
    sessionId: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
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
      connectedPtyEvidence: { tabIds: new Set(), paneKeys: new Set(), ptyIds: new Set() },
      retainedSnapshots: [],
      hookSnapshots: [],
      structuredSummaries: summaries
    }),
    orchestrationByPaneKey: null,
    getSummary: (map, _p, _m, id) => map.get(id) ?? null
  })
  return row
}

describe('worktree ps reports structured sessions', () => {
  it('a busy structured session is not reported idle', () => {
    const row = attach([summary()])
    expect(row.agents).toHaveLength(1)
    expect(row.agents[0]?.state).toBe('working')
    expect(row.agents[0]?.agentType).toBe('claude')
    expect(row.agents[0]?.prompt).toBe('ship the thing')
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
    const sessionId = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
    expect(row.agents[0]?.paneKey).toBe(
      structuredAgentSessionPaneKey(structuredAgentSessionTabId(sessionId), sessionId)
    )
  })

  // Null status means no turn has been persisted; the chat itself shows nothing, so neither does this.
  it('omits a session with no projected status', () => {
    expect(attach([summary({ status: null })]).agents).toHaveLength(0)
  })
})

/**
 * The deliberate non-goal. Adding structured rows to `terminal list` was investigated and rejected:
 * mobile mounts a terminal WebView per row that can never receive a frame, a `connected`-keyed
 * refresh check goes permanently true and pins shipped clients to a fast cadence with no exit, and
 * the plugin projection has no field that can carry `writable: false`. Every SAFE consumer of a
 * terminal summary checks `ptyId`; the breaking ones key off `connected` or mere row presence,
 * which no added field can qualify. A separate change publishes an honest partial-listing count
 * there instead. This pins that only `worktree ps` gained the enumerator.
 */
describe('terminal listing is deliberately left alone', () => {
  it('only worktree ps consumes the structured status summaries', async () => {
    const { readFile } = await import('node:fs/promises')
    // orca-runtime-subscribe-to-terminal-resize.ts owns listTerminals.
    const listing = await readFile(
      new URL('./orca-runtime-subscribe-to-terminal-resize.ts', import.meta.url),
      'utf8'
    )
    // Guard the guard: an empty read would make every assertion below vacuously true.
    expect(listing).toContain('async listTerminals(')
    expect(listing).not.toContain('liveSessionStatusSummaries')
    expect(listing).not.toContain('structuredSummaries')

    const worktreePs = await readFile(
      new URL('./orca-runtime-get-worktree-ps.ts', import.meta.url),
      'utf8'
    )
    expect(worktreePs).toContain('liveSessionStatusSummaries')
  })
})
