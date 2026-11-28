import { expect, it } from 'vitest'
import { sessionLiveActivityContent } from './session-live-activity-content'

it('exports only consented names and durable failure state across the lock-screen boundary', () => {
  const tab = {
    type: 'terminal' as const,
    id: 'tab',
    parentTabId: 'tab',
    leafId: 'leaf',
    title: 'Private project',
    isActive: true,
    terminal: 'term',
    status: 'ready' as const,
    agentStatus: {
      paneKey: 'pane',
      state: 'done' as const,
      prompt: 'secret prompt',
      updatedAt: 20_000,
      stateStartedAt: 18_000,
      stateHistory: [],
      mainAgent: {
        state: 'done' as const,
        outcome: 'failure' as const,
        stateStartedAt: 18_000,
        failure: { error: 'provider_error', message: 'private error detail' }
      }
    }
  }
  expect(sessionLiveActivityContent(tab, false, undefined, 20_000)).toEqual({
    state: 'failed',
    title: 'Orca',
    stateStartedAt: 18,
    updatedAt: 20
  })
  expect(sessionLiveActivityContent(tab, true, undefined, 20_000)).toEqual({
    state: 'failed',
    title: 'Private project',
    stateStartedAt: 18,
    updatedAt: 20
  })
})
