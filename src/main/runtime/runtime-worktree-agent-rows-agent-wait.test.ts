import { AgentHookServer } from '../agent-hooks/server'
import { makePaneKey } from '../../shared/stable-pane-id'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeWorktreeAgentSource } from './runtime-worktree-agent-source'
import type { RuntimeWorktreePsSummary } from '../../shared/runtime-types'
import { attachRuntimeWorktreeAgentRows } from './runtime-worktree-agent-rows'
import { attachRuntimeWorktreeAgentRowWaits } from './runtime-worktree-agent-row-waits'
import { collectRuntimeWorktreeAgentSources } from './runtime-worktree-agent-sources'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))

/**
 * `worktree ps --json` must answer what `terminal show --json` would for the same agent, so a
 * fleet sweep no longer needs a second call per lane to tell "parked on a human" from "between
 * turns" (#23921). These tests walk a real status-store snapshot through the row-wait threading
 * and the row builder.
 */
const WORKTREE_ID = 'wt-1'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = makePaneKey('tab-1', LEAF_ID)
const HANDLE = 'term-1'
const PTY_ID = 'pty-1'

function ingestWaitingRow(options: { terminalHandle?: string } = {}): AgentHookServer {
  const store = new AgentHookServer()
  store.ingestTerminalStatus({
    paneKey: PANE_KEY,
    tabId: 'tab-1',
    worktreeId: WORKTREE_ID,
    connectionId: null,
    ...(options.terminalHandle !== undefined ? { terminalHandle: options.terminalHandle } : {}),
    payload: { state: 'waiting', prompt: 'review the PR', agentType: 'claude' }
  })
  return store
}

function collectRows(store: AgentHookServer): ReadonlyMap<string, RuntimeWorktreeAgentSource> {
  return collectRuntimeWorktreeAgentSources({
    mirroredWorktreeIdByTabId: new Map(),
    connectedPtyEvidence: {
      tabIds: new Set(),
      paneKeys: new Set([PANE_KEY]),
      ptyIdByTerminalHandle: new Map([[HANDLE, PTY_ID]])
    },
    hookSnapshots: store.getStatusSnapshot()
  })
}

function attachRows(rowSources: ReadonlyMap<string, RuntimeWorktreeAgentSource>): {
  row: RuntimeWorktreePsSummary
  agents: RuntimeWorktreeAgentRowShape[]
} {
  const summary = {
    worktreeId: WORKTREE_ID,
    status: 'inactive',
    hasHostSidebarActivity: false,
    agents: []
  } as unknown as RuntimeWorktreePsSummary
  attachRuntimeWorktreeAgentRows({
    summaries: new Map([[WORKTREE_ID, summary]]),
    pathIndex: { byPath: new Map(), byRealPath: new Map() } as never,
    missingWorktreeIds: new Set(),
    workingTerminalEvidenceByWorktreeId: new Map(),
    rowSources,
    orchestrationByPaneKey: null,
    getSummary: (map, _p, _m, id) => map.get(id) ?? null
  })
  return { row: summary, agents: summary.agents as unknown as RuntimeWorktreeAgentRowShape[] }
}

type RuntimeWorktreeAgentRowShape = RuntimeWorktreePsSummary['agents'][number]

beforeEach(() => {
  // The status store tracks hook-source stats on ingest.
  vi.clearAllMocks()
})

describe('worktree ps rows carry the terminal wait signal', () => {
  it('threads a populated wait from the terminal getter onto the row', async () => {
    const rowSources = collectRows(ingestWaitingRow({ terminalHandle: HANDLE }))
    const getWait = vi.fn().mockResolvedValue({ source: 'prompt-text', reason: 'clarify' })

    const enriched = await attachRuntimeWorktreeAgentRowWaits(rowSources, getWait)
    const { agents } = attachRows(enriched)

    expect(getWait).toHaveBeenCalledWith(HANDLE)
    expect(agents[0]).toMatchObject({ state: 'waiting', agentWait: { source: 'prompt-text' } })
  })

  it('reports an explicit null when the getter looked and found no wait', async () => {
    const rowSources = collectRows(ingestWaitingRow({ terminalHandle: HANDLE }))
    const getWait = vi.fn().mockResolvedValue(null)

    const enriched = await attachRuntimeWorktreeAgentRowWaits(rowSources, getWait)
    const { agents } = attachRows(enriched)

    expect(agents[0]?.agentWait).toBeNull()
  })

  it('keeps agentWait absent when the lookup cannot evaluate', async () => {
    const rowSources = collectRows(ingestWaitingRow({ terminalHandle: HANDLE }))
    const getWait = vi.fn().mockResolvedValue(undefined)

    const enriched = await attachRuntimeWorktreeAgentRowWaits(rowSources, getWait)
    const { agents } = attachRows(enriched)

    expect(agents[0]).not.toHaveProperty('agentWait')
  })

  it('never calls the wait getter for a row without a terminal handle', async () => {
    const store = ingestWaitingRow()
    const rowSources = collectRows(store)
    expect([...rowSources.values()][0]?.terminalHandle).toBeUndefined()
    const getWait = vi.fn()

    const enriched = await attachRuntimeWorktreeAgentRowWaits(rowSources, getWait)
    const { agents } = attachRows(enriched)

    expect(getWait).not.toHaveBeenCalled()
    expect(agents[0]).toMatchObject({ state: 'waiting' })
    expect(agents[0]).not.toHaveProperty('agentWait')
  })
})
