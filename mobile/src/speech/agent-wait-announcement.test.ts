import { describe, expect, it, vi } from 'vitest'
import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-types'

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => undefined) }
}))

const { findNewWaits, waitAnnouncement } = await import('./agent-wait-announcement')

function agent(overrides: Partial<RuntimeWorktreeAgentRow>): RuntimeWorktreeAgentRow {
  return {
    paneKey: 'pane-1',
    parentPaneKey: null,
    state: 'working',
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

describe('findNewWaits', () => {
  it('does not announce a wait that was there when the pane was first seen', () => {
    const { newWaits } = findNewWaits(new Map(), [agent({ state: 'waiting', stateStartedAt: 5 })])
    expect(newWaits).toEqual([])
  })

  it('announces a wait that begins after the pane was first seen, once', () => {
    const first = findNewWaits(new Map(), [agent({})])
    const waiting = agent({ state: 'waiting', stateStartedAt: 10, toolName: 'Bash' })
    const second = findNewWaits(first.baseline, [waiting])
    expect(second.newWaits).toEqual([{ paneKey: 'pane-1', since: 10, kind: 'permission' }])
    expect(findNewWaits(second.baseline, [waiting]).newWaits).toEqual([])
  })

  it('announces the next wait after the agent went back to work', () => {
    const first = findNewWaits(new Map(), [agent({ state: 'waiting', stateStartedAt: 10 })])
    const working = findNewWaits(first.baseline, [agent({ stateStartedAt: 20 })])
    const again = findNewWaits(working.baseline, [agent({ state: 'blocked', stateStartedAt: 30 })])
    expect(again.newWaits).toEqual([{ paneKey: 'pane-1', since: 30, kind: 'other' }])
  })

  it('tells a question from a permission request', () => {
    const first = findNewWaits(new Map(), [agent({})])
    const question = agent({ state: 'waiting', stateStartedAt: 10, toolName: 'AskUserQuestion' })
    expect(findNewWaits(first.baseline, [question]).newWaits[0]?.kind).toBe('question')
  })

  it("goes by the main agent's own state, and skips subagent rows", () => {
    const first = findNewWaits(new Map(), [agent({}), agent({ paneKey: 'child' })])
    const rows = [
      agent({ mainAgent: { state: 'waiting', stateStartedAt: 40 }, stateStartedAt: 1 }),
      agent({ paneKey: 'child', parentPaneKey: 'pane-1', state: 'waiting', stateStartedAt: 50 })
    ]
    expect(findNewWaits(first.baseline, rows).newWaits).toEqual([
      { paneKey: 'pane-1', since: 40, kind: 'other' }
    ])
  })
})

describe('waitAnnouncement', () => {
  it("speaks the reading voice's language", () => {
    expect(waitAnnouncement('question', 'pl')).toBe('Agent ma pytanie.')
    expect(waitAnnouncement('permission', 'en')).toBe('The agent asks for permission.')
    expect(waitAnnouncement('other', 'es')).toBe('El agente te está esperando.')
  })
})
