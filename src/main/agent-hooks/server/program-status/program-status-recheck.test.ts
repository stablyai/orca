import { afterEach, expect, it, vi } from 'vitest'
import { createHookListenerState } from '../../../../shared/agent-hook-listener/listener-state'
import type { AgentHookEventPayload } from '../../../../shared/agent-hook-listener/listener-event'
import { PaneTimers } from './pane-timers'
import { discardAntigravityDone } from './program-status-recheck'

afterEach(() => {
  vi.useRealTimers()
})

it('keeps a parked agy done when the status apply rejects an explicit prompt', () => {
  vi.useFakeTimers()
  const timers = new PaneTimers()
  const settle = vi.fn()
  timers.park('pane', settle)
  const row: AgentHookEventPayload = {
    paneKey: 'pane',
    connectionId: null,
    payload: {
      state: 'working',
      agentType: 'antigravity',
      prompt: 'continue',
      mainAgent: { state: 'done', stateStartedAt: 1 }
    }
  }
  const incoming = { ...row, hasExplicitPrompt: true }
  discardAntigravityDone(createHookListenerState(), timers, incoming, row, row)
  timers.wake('pane')
  vi.runAllTimers()
  expect(settle).toHaveBeenCalledTimes(1)
})
