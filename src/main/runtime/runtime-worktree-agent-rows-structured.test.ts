import { makeStructuredAgentStatusSubject } from '../../shared/agent-status-subject'
import { collectRuntimeWorktreeAgentSources } from './runtime-worktree-agent-sources'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { statusFeedChildView } from '../native-chat/agent-session-wire/structured-agent-session-status-feed-test-session'
import { normalizeAgentStatusPayload } from '../../shared/agent-status-types'
import { resolveWorktreeCatalogSnapshot } from './rpc/worktree-catalog-snapshot'
import { attachRuntimeWorktreeAgentRows } from './runtime-worktree-agent-rows'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../shared/structured-agent-session-projection'
import type { AgentSessionStatusSummary } from '../../shared/agent-session-wire'
import type { RuntimeWorktreePsSummary } from '../../shared/runtime-types'
import { AgentHookServer, _internals } from '../agent-hooks/server'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: vi.fn(() => ({ nth_repo_added: 2 }))
}))

/** Structured sessions have no PTY/hooks; host-published status must reach worktree ps as well as the sidebar. */
const WORKTREE_ID = 'repo-1::/workspace/app'
const SESSION = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
const SUBJECT = makeStructuredAgentStatusSubject(
  {
    executionHostId: 'local',
    wslDistro: null,
    workspaceId: WORKTREE_ID,
    workspaceKind: 'git-worktree'
  },
  SESSION
)

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
    store.ingestStructuredStatus(entry, SUBJECT)
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
    terminalTitleEvidenceByWorktreeId: new Map(),
    rowSources: collectRuntimeWorktreeAgentSources({
      mirroredWorktreeIdByTabId: new Map(),
      connectedPtyEvidence: {
        tabIds: new Set(),
        paneKeys: new Set(),
        ptyIdByTerminalHandle: new Map()
      },
      hookSnapshots: store.getStatusSnapshot(),
      readStructuredSummary: (sessionId) =>
        summaries.findLast((entry) => entry.sessionId === sessionId)
    }),
    orchestrationByPaneKey: null,
    getSummary: (id) => summariesById.get(id) ?? null
  })
  return row
}

beforeEach(() => {
  _internals.resetCachesForTests()
})

describe('worktree ps reports structured sessions', () => {
  it('carries canonical summary children, invalidates child-only changes, and clears an omitted roster', () => {
    const child = statusFeedChildView()
    const catalog = (children: (typeof child)[] | undefined) => ({
      worktrees: [attach([summary({ children })])],
      totalCount: 1,
      truncated: false
    })
    const first = catalog([child])
    expect(first.worktrees[0]?.agents[0]).toMatchObject({
      children: [child],
      subagentObservation: 'live'
    })
    const initial = resolveWorktreeCatalogSnapshot(first, null)
    expect(resolveWorktreeCatalogSnapshot(catalog([child]), initial.snapshotId)).toEqual({
      unchanged: true,
      snapshotId: initial.snapshotId
    })
    expect(
      resolveWorktreeCatalogSnapshot(catalog([{ ...child, state: 'waiting' }]), initial.snapshotId)
    ).not.toHaveProperty('unchanged')
    expect(catalog(undefined).worktrees[0]?.agents[0]?.children).toEqual([])
    // Old readers keep the parent fields; hook payloads cannot become a child producer.
    expect(normalizeAgentStatusPayload({ state: 'working', children: [child] })).not.toHaveProperty(
      'children'
    )
  })

  it("lists a person's Stop still ending the turn, and drops it once the host does", () => {
    expect(attach([summary({ stopping: true })]).agents[0]).toMatchObject({
      state: 'working',
      mainAgent: { state: 'working', stopping: true }
    })
    const ended = attach([summary({ stopping: true }), summary({ updatedAt: 1_757_030_401_000 })])
    expect(ended.agents[0]?.state).toBe('working')
    expect(ended.agents[0]?.mainAgent).not.toHaveProperty('stopping')
  })

  it('a busy structured session is not reported idle', () => {
    const row = attach([summary()])
    expect(row.agents).toHaveLength(1)
    expect(row.agents[0]?.state).toBe('working')
    expect(row.agents[0]?.agentType).toBe('claude')
    expect(row.agents[0]?.prompt).toBe('ship the thing')
    expect(row.status).toBe('working')
  })

  it('does not turn a completed host-held session into permission', () => {
    const row = attach([summary({ status: 'idle' })])
    expect(row.status).toBe('inactive')
    expect(row.hasHostSidebarActivity).toBe(false)
  })

  it('reports the DERIVED pane key, never an orchestration credential', () => {
    const row = attach([summary()])
    expect(row.agents[0]?.paneKey).toBe(
      structuredAgentSessionPaneKey(structuredAgentSessionTabId(SESSION), SESSION)
    )
  })

  // No persisted turn means no projected status, matching the chat.
  it('omits a session with no projected status', () => {
    expect(attach([summary({ status: null })]).agents).toHaveLength(0)
  })

  it('keeps the journal clock on the row, so a restart republish is not new activity', () => {
    const row = attach([summary()])
    expect(row.agents[0]?.updatedAt).toBe(1_757_030_400_000)
    expect(row.agents[0]?.stateStartedAt).toBe(1_757_030_400_000)
  })
})

/** Keep structured rows out of terminal list: shipped clients mount WebViews and poll by row presence/connected, which no added field can qualify. */
describe('terminal listing is deliberately left alone', () => {
  it('never reads the agent-status store that now carries structured rows', async () => {
    const { readFile } = await import('node:fs/promises')
    const listing = await readFile(
      new URL('./terminal/layout/terminal-resize-listeners.ts', import.meta.url),
      'utf8'
    )
    // An empty source read would satisfy every negative assertion.
    expect(listing).toContain('async listTerminals(')
    expect(listing).not.toContain('getAgentStatusSnapshotFn')
    expect(listing).not.toContain('structuredHost')
  })
})
