import { describe, expect, it, vi } from 'vitest'
import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-types'

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => undefined) }
}))

vi.mock('react-native', () => ({ AppState: { currentState: 'active' } }))
vi.mock('../transport/client-context', () => ({ useRpcClientContext: vi.fn() }))

const { agentRowsFromWorktreePs, findNewReplies } = await import('./use-auto-read-replies')

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
    expect(second.newReplies).toEqual([{ paneKey: 'pane-1', message: 'Done!' }])
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
    expect(next.newReplies).toEqual([{ paneKey: 'pane-1', message: 'C' }])
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
    expect(ended.newReplies).toEqual([{ paneKey: 'pane-1', message: 'B' }])
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

  it('keeps panes of different hosts apart', () => {
    const result = {
      worktrees: [{ agents: [agent({ paneKey: 'p', parentPaneKey: 'root' })] }, { agents: null }]
    }
    expect(agentRowsFromWorktreePs('host-a', result)).toMatchObject([
      { paneKey: 'host-a:p', parentPaneKey: 'host-a:root' }
    ])
    expect(agentRowsFromWorktreePs('host-a', { nope: true })).toEqual([])
    expect(agentRowsFromWorktreePs('host-a', null)).toEqual([])
  })

  it('skips subagent rows', () => {
    const baseline = new Map([['child', '']])
    const { newReplies } = findNewReplies(baseline, [
      agent({ paneKey: 'child', parentPaneKey: 'pane-1', lastAssistantMessage: 'step' })
    ])
    expect(newReplies).toEqual([])
  })
})
