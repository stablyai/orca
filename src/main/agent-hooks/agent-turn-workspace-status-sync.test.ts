import { beforeEach, describe, expect, it } from 'vitest'
import {
  maybeSyncWorkspaceStatusOnAgentTurn,
  resetAgentTurnWorkspaceStatusState,
  type AgentTurnWorkspaceStatusDeps,
  type AgentTurnWorkspaceStatusEvent,
  type AgentTurnWorkspaceStatusPane
} from './agent-turn-workspace-status-sync'
import {
  DEFAULT_WORKSPACE_STATUS_ID,
  WORKSPACE_STATUS_IN_REVIEW_ID,
  WORKSPACE_STATUS_TODO_ID,
  cloneDefaultWorkspaceStatuses
} from '../../shared/workspace-statuses'
import type { AgentStatusState } from '../../shared/agent-status-types'
import type { AgentTurnOutcome } from '../../shared/agent-turn-outcome'
import type { WorkspaceStatus, WorkspaceStatusDefinition } from '../../shared/worktree/types'

const WORKTREE_ID = 'tab:tab-1'

function event(
  overrides: Partial<AgentTurnWorkspaceStatusEvent> = {}
): AgentTurnWorkspaceStatusEvent {
  return {
    paneKey: 'tab-1:0',
    tabId: 'tab-1',
    worktreeId: 'echoed::/other',
    leadState: undefined,
    rowState: 'working',
    leadOutcome: undefined,
    sessionBoundary: undefined,
    isReplay: undefined,
    restoredUnconfirmed: undefined,
    providerSessionOnly: undefined,
    ...overrides
  }
}

type TurnStep = {
  rowState?: AgentStatusState
  leadState?: AgentStatusState
  leadOutcome?: AgentTurnOutcome
  sessionBoundary?: boolean
  isReplay?: boolean
  restoredUnconfirmed?: boolean
  providerSessionOnly?: boolean
}

type BoardWrite = [string, WorkspaceStatus]

function makeDeps(
  options: {
    enabled?: boolean
    statuses?: WorkspaceStatusDefinition[]
    current?: WorkspaceStatus
    livePanes?: AgentTurnWorkspaceStatusPane[]
  } = {}
): { deps: AgentTurnWorkspaceStatusDeps; writes: BoardWrite[] } {
  const writes: BoardWrite[] = []
  const deps: AgentTurnWorkspaceStatusDeps = {
    isEnabled: () => options.enabled ?? true,
    getWorkspaceStatuses: () => options.statuses ?? cloneDefaultWorkspaceStatuses(),
    resolveWorktreeIdForTab: (tabId) => `tab:${tabId}`,
    getWorkspaceStatus: () => options.current ?? DEFAULT_WORKSPACE_STATUS_ID,
    getLivePanes: () => options.livePanes ?? [],
    setWorkspaceStatus: async (worktreeId, status) => {
      writes.push([worktreeId, status])
    }
  }
  return { deps, writes }
}

/** Drives one pane through `states` in order and returns what the board recorded. */
async function runTurn(
  states: TurnStep[],
  options: Parameters<typeof makeDeps>[0] = {}
): Promise<BoardWrite[]> {
  const { deps, writes } = makeDeps(options)
  for (const state of states) {
    await maybeSyncWorkspaceStatusOnAgentTurn(event(state), deps)
  }
  return writes
}

beforeEach(() => {
  resetAgentTurnWorkspaceStatusState()
})

describe('maybeSyncWorkspaceStatusOnAgentTurn', () => {
  it('stays put while the preference is off', async () => {
    const writes = await runTurn([{ rowState: 'working' }, { rowState: 'done' }], {
      enabled: false
    })
    expect(writes).toEqual([])
  })

  it('moves the card to In review when the lead finishes a turn', async () => {
    const writes = await runTurn([{ rowState: 'working' }, { rowState: 'done' }])
    expect(writes).toEqual([[WORKTREE_ID, WORKSPACE_STATUS_IN_REVIEW_ID]])
  })

  it('prefers the lead state over the combined row state', async () => {
    const writes = await runTurn([
      { rowState: 'working', leadState: 'working' },
      { rowState: 'working', leadState: 'done' }
    ])
    expect(writes).toEqual([[WORKTREE_ID, WORKSPACE_STATUS_IN_REVIEW_ID]])
  })

  it('does not hand off while the lead record still reports work', async () => {
    const writes = await runTurn([
      { rowState: 'working' },
      { rowState: 'done', leadState: 'working' }
    ])
    expect(writes).toEqual([])
  })

  it('ignores a connect/resume landing idle', async () => {
    const writes = await runTurn([
      { rowState: 'working' },
      { rowState: 'done', sessionBoundary: true }
    ])
    expect(writes).toEqual([])
  })

  it('ignores the first idle row a freshly opened session reports', async () => {
    const writes = await runTurn([{ rowState: 'done' }])
    expect(writes).toEqual([])
  })

  it.each([
    ['a relay replay', { isReplay: true }],
    ['an unconfirmed hydrated row', { restoredUnconfirmed: true }],
    ['a session-identity refresh', { providerSessionOnly: true }]
  ] as const)('ignores %s', async (_label, override) => {
    const writes = await runTurn([{ rowState: 'working' }, { rowState: 'done', ...override }])
    expect(writes).toEqual([])
  })

  it.each(['cancellation', 'interruption', 'unconfirmed', 'superseded'] as const)(
    'does not hand off a turn that ended as %s',
    async (outcome) => {
      const writes = await runTurn([
        { rowState: 'working' },
        { rowState: 'done', leadOutcome: outcome }
      ])
      expect(writes).toEqual([])
    }
  )

  it('hands off a turn the provider settled as success', async () => {
    const writes = await runTurn([
      { rowState: 'working' },
      { rowState: 'done', leadOutcome: 'success' }
    ])
    expect(writes).toEqual([[WORKTREE_ID, WORKSPACE_STATUS_IN_REVIEW_ID]])
  })

  it('waits for the last pane of a multi-session workspace', async () => {
    const writes = await runTurn([{ rowState: 'working' }, { rowState: 'done' }], {
      livePanes: [{ paneKey: 'tab-1:1', worktreeId: WORKTREE_ID, state: 'working' }]
    })
    expect(writes).toEqual([])
  })

  it('moves once the sibling pane has also finished', async () => {
    const writes = await runTurn([{ rowState: 'working' }, { rowState: 'done' }], {
      livePanes: [{ paneKey: 'tab-1:1', worktreeId: WORKTREE_ID, state: 'done' }]
    })
    expect(writes).toEqual([[WORKTREE_ID, WORKSPACE_STATUS_IN_REVIEW_ID]])
  })

  it('moves a new turn out of In review and back into In progress', async () => {
    const writes = await runTurn([{ rowState: 'done' }, { rowState: 'working' }], {
      current: WORKSPACE_STATUS_IN_REVIEW_ID
    })
    expect(writes).toEqual([[WORKTREE_ID, DEFAULT_WORKSPACE_STATUS_ID]])
  })

  it('pulls a Todo card into In progress when its first turn starts', async () => {
    const writes = await runTurn([{ rowState: 'working' }], { current: WORKSPACE_STATUS_TODO_ID })
    expect(writes).toEqual([[WORKTREE_ID, DEFAULT_WORKSPACE_STATUS_ID]])
  })

  it('never drags a card out of Done', async () => {
    const writes = await runTurn([{ rowState: 'working' }, { rowState: 'done' }], {
      current: 'completed'
    })
    expect(writes).toEqual([])
  })

  it('never drags a card out of a column the person placed it in', async () => {
    const writes = await runTurn([{ rowState: 'working' }, { rowState: 'done' }], {
      current: 'blocked-on-design'
    })
    expect(writes).toEqual([])
  })

  it('stays put when the In review column was removed', async () => {
    const writes = await runTurn([{ rowState: 'working' }, { rowState: 'done' }], {
      statuses: cloneDefaultWorkspaceStatuses().filter((status) => status.id !== 'in-review')
    })
    expect(writes).toEqual([])
  })

  it('stays put when the card is already in the column the edge would move it to', async () => {
    let current: WorkspaceStatus = DEFAULT_WORKSPACE_STATUS_ID
    const { deps, writes } = makeDeps()
    deps.getWorkspaceStatus = () => current
    await maybeSyncWorkspaceStatusOnAgentTurn(event({ rowState: 'working' }), deps)
    // The person moved it by hand while the turn ran.
    current = WORKSPACE_STATUS_IN_REVIEW_ID
    await maybeSyncWorkspaceStatusOnAgentTurn(event({ rowState: 'done' }), deps)
    expect(writes).toEqual([])
  })

  it('falls back to the worktree the agent echoed when the tab map has no entry', async () => {
    const { deps, writes } = makeDeps()
    deps.resolveWorktreeIdForTab = () => undefined
    await maybeSyncWorkspaceStatusOnAgentTurn(event({ rowState: 'working' }), deps)
    await maybeSyncWorkspaceStatusOnAgentTurn(event({ rowState: 'done' }), deps)
    expect(writes).toEqual([['echoed::/other', WORKSPACE_STATUS_IN_REVIEW_ID]])
  })

  it('stays put when neither the tab map nor the agent identifies a workspace', async () => {
    const { deps, writes } = makeDeps()
    deps.resolveWorktreeIdForTab = () => undefined
    await maybeSyncWorkspaceStatusOnAgentTurn(
      event({ rowState: 'working', tabId: undefined, worktreeId: undefined }),
      deps
    )
    await maybeSyncWorkspaceStatusOnAgentTurn(
      event({ rowState: 'done', tabId: undefined, worktreeId: undefined }),
      deps
    )
    expect(writes).toEqual([])
  })
})
