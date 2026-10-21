import { describe, expect, it } from 'vitest'
import type { RuntimeWorktreeAgentRow } from '../shared/runtime-types'
import { formatWorktreePsProgramStatus } from './worktree-ps-program-status'

function agent(over: Partial<RuntimeWorktreeAgentRow>): RuntimeWorktreeAgentRow {
  return {
    paneKey: 'tab:leaf',
    parentPaneKey: null,
    state: 'working',
    agentType: 'codex',
    prompt: 'ship it',
    taskTitle: null,
    displayName: null,
    lastAssistantMessage: null,
    toolName: null,
    toolInput: null,
    interrupted: false,
    stateStartedAt: 1,
    updatedAt: 1,
    ...over
  }
}

describe('formatWorktreePsProgramStatus', () => {
  it('is empty without agents or facets', () => {
    expect(formatWorktreePsProgramStatus(undefined)).toBe('')
    expect(formatWorktreePsProgramStatus([agent({})])).toBe('')
  })

  it('shows live progress', () => {
    const programStatus = { state: 'working' as const, progress: 42, observedAt: 1 }
    expect(formatWorktreePsProgramStatus([agent({ programStatus })])).toBe('  42%')
  })

  it('prefers a reported block over another agent progress', () => {
    const working = agent({ programStatus: { state: 'working', progress: 42, observedAt: 1 } })
    const signIn = agent({
      paneKey: 'tab:leaf-2',
      state: 'done',
      programStatus: { state: 'blocked', kind: 'auth', observedAt: 1 }
    })
    expect(formatWorktreePsProgramStatus([working, signIn])).toBe('  (Sign-in required)')
  })

  it('hides progress on a finished row', () => {
    const programStatus = { state: 'working' as const, progress: 42, observedAt: 1 }
    expect(formatWorktreePsProgramStatus([agent({ state: 'done', programStatus })])).toBe('')
  })
})
