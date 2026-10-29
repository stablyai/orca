import { describe, expect, it, vi } from 'vitest'
import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-types'

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => undefined) }
}))

vi.mock('react-native', () => ({ AppState: { currentState: 'active' } }))
vi.mock('../transport/client-context', () => ({ useRpcClientContext: vi.fn() }))

const { findNewReplies } = await import('./use-auto-read-replies')
const { agentRowsFromWorktreePs } = await import('./auto-read-agent-rows')

function agent(overrides: Partial<RuntimeWorktreeAgentRow>): RuntimeWorktreeAgentRow {
  return {
    paneKey: 'pane-1',
    parentPaneKey: null,
    state: 'done',
    agentType: 'claude',
    prompt: '',
    taskTitle: null,
    displayName: null,
    lastAssistantMessage: null,
    toolName: null,
    toolInput: null,
    interrupted: false,
    stateStartedAt: 0,
    updatedAt: 0,
    ...overrides
  }
}

describe('findNewReplies', () => {
  it('does not read replies that existed when the pane was first seen', () => {
    const { newReplies } = findNewReplies(new Map(), [agent({ lastAssistantMessage: 'Old reply' })])
    expect(newReplies).toEqual([])
  })

  it('reads a reply that finishes after the pane was first seen', () => {
    const first = findNewReplies(new Map(), [agent({ state: 'working' })])
    const second = findNewReplies(first.baseline, [agent({ lastAssistantMessage: 'Done!' })])
    expect(second.newReplies).toEqual([{ paneKey: 'pane-1', message: 'Done!', endedAt: 0 }])
  })

  it('reads each reply once, and again only when it changes', () => {
    const first = findNewReplies(new Map([['pane-1', 'A']]), [agent({ lastAssistantMessage: 'B' })])
    const repeat = findNewReplies(first.baseline, [agent({ lastAssistantMessage: 'B' })])
    const working = findNewReplies(repeat.baseline, [
      agent({ state: 'working', lastAssistantMessage: 'B' })
    ])
    const next = findNewReplies(working.baseline, [agent({ lastAssistantMessage: 'C' })])
    expect(first.newReplies).toHaveLength(1)
    expect(repeat.newReplies).toEqual([])
    expect(working.newReplies).toEqual([])
    expect(next.newReplies).toEqual([{ paneKey: 'pane-1', message: 'C', endedAt: 0 }])
  })

  it('reads a reply that lands while a background task keeps the row working', () => {
    const first = findNewReplies(new Map([['pane-1', 'A']]), [
      agent({ state: 'working', lastAssistantMessage: null })
    ])
    const ended = findNewReplies(first.baseline, [
      agent({
        state: 'working',
        mainAgent: { state: 'done', stateStartedAt: 1 },
        lastAssistantMessage: 'B'
      })
    ])
    expect(first.newReplies).toEqual([])
    expect(ended.newReplies).toEqual([{ paneKey: 'pane-1', message: 'B', endedAt: 1 }])
  })

  it('never reads tool output the host shows while the main agent is still working', () => {
    const toolOutput = findNewReplies(new Map([['pane-1', 'A']]), [
      agent({
        state: 'working',
        mainAgent: { state: 'working', stateStartedAt: 1 },
        lastAssistantMessage: 'search results: 10 camping stoves…'
      })
    ])
    const rowOnly = findNewReplies(new Map([['pane-1', 'A']]), [
      agent({ state: 'working', lastAssistantMessage: 'file contents…' })
    ])
    expect(toolOutput.newReplies).toEqual([])
    expect(rowOnly.newReplies).toEqual([])
  })

  it("reads a new agent's first reply even when its whole turn ended between two polls", () => {
    const { newReplies } = findNewReplies(
      new Map([['pane-1', '']]),
      [agent({ paneKey: 'new', lastAssistantMessage: 'Quick answer' })],
      true
    )
    expect(newReplies).toEqual([{ paneKey: 'new', message: 'Quick answer', endedAt: 0 }])
  })

  it('reads the same answer again when another turn ends with it', () => {
    const first = findNewReplies(new Map(), [
      agent({ stateStartedAt: 1, lastAssistantMessage: 'Same' })
    ])
    const again = findNewReplies(first.baseline, [
      agent({ stateStartedAt: 1, lastAssistantMessage: 'Same' })
    ])
    const nextTurn = findNewReplies(again.baseline, [
      agent({ stateStartedAt: 2, lastAssistantMessage: 'Same' })
    ])
    expect(first.newReplies).toEqual([])
    expect(again.newReplies).toEqual([])
    expect(nextTurn.newReplies).toEqual([{ paneKey: 'pane-1', message: 'Same', endedAt: 2 }])
  })

  it('keeps panes of different hosts apart', () => {
    const worktrees = [
      { agents: [agent({ paneKey: 'p', parentPaneKey: 'root' })] },
      { agents: null },
      null
    ]
    expect(agentRowsFromWorktreePs('host-a', worktrees)).toMatchObject([
      { paneKey: 'host-a:p', parentPaneKey: 'host-a:root', rawPaneKey: 'p' }
    ])
  })

  it('skips agent rows it cannot read, and a main agent it cannot read', () => {
    const worktrees = [
      {
        worktreeId: 'wt',
        agents: [
          { paneKey: 'no-state', stateStartedAt: 0 },
          { ...agent({ paneKey: 'future' }), state: 'thinking' },
          { ...agent({ paneKey: 'old-host' }), mainAgent: { state: 'thinking' } }
        ]
      }
    ]
    const rows = agentRowsFromWorktreePs('host-a', worktrees)
    expect(rows.map((row) => [row.paneKey, row.mainAgent])).toEqual([
      ['host-a:old-host', undefined]
    ])
  })

  it('skips subagent rows', () => {
    const baseline = new Map([['child', '']])
    const { newReplies } = findNewReplies(baseline, [
      agent({ paneKey: 'child', parentPaneKey: 'pane-1', lastAssistantMessage: 'step' })
    ])
    expect(newReplies).toEqual([])
  })
})
