import { describe, expect, it, vi } from 'vitest'

import { createHookListenerState } from '../shared/agent-hook-listener/listener-state'
import type { AgentHookEventPayload } from '../shared/agent-hook-listener/listener-event'
import { applyRelayEvent } from './agent-hook-event-application'

const PANE_KEY = 'tab-1:11111111-1111-4111-8111-111111111111'

function apply(
  isReplay: boolean,
  isPaneSurfaceRetired: (paneKey: string) => boolean = () => false
): {
  live: ReturnType<typeof vi.fn>
  restart: ReturnType<typeof vi.fn>
  forward: ReturnType<typeof vi.fn>
  clearPaneState: ReturnType<typeof vi.fn>
} {
  const scheduleCodexReconciliation = vi.fn()
  const scheduleCodexRestartReconciliation = vi.fn()
  const forward = vi.fn()
  const clearPaneState = vi.fn()
  const event: AgentHookEventPayload = {
    paneKey: PANE_KEY,
    source: 'codex',
    connectionId: null,
    hookEventName: 'UserPromptSubmit',
    payload: { state: 'working', prompt: 'new turn', agentType: 'codex' }
  }
  applyRelayEvent({
    state: createHookListenerState(),
    event,
    source: 'codex',
    isReplay,
    metadata: new Map(),
    persist: vi.fn(),
    clearPaneState,
    forward,
    scheduleCodexReconciliation,
    scheduleCodexRestartReconciliation,
    clearAssistantMessageRetry: vi.fn(),
    isPaneSurfaceRetired
  })
  return {
    live: scheduleCodexReconciliation,
    restart: scheduleCodexRestartReconciliation,
    forward,
    clearPaneState
  }
}

describe('relay hook event application', () => {
  it('uses live reconciliation for live events', () => {
    const scheduled = apply(false)
    expect(scheduled.live).toHaveBeenCalledWith(PANE_KEY)
    expect(scheduled.restart).not.toHaveBeenCalled()
  })

  it('preserves replay provenance for spool replay reconciliation', () => {
    const scheduled = apply(true)
    expect(scheduled.restart).toHaveBeenCalledWith(PANE_KEY)
    expect(scheduled.live).not.toHaveBeenCalled()
  })

  // Why: the retired-surface gate moved here from RelayAgentHookServer.applyEvent (#17012); pin it
  // at its new home so a later extraction can't drop it again.
  it('drops a retired pane surface instead of caching or forwarding it', () => {
    const applied = apply(false, (paneKey) => paneKey === PANE_KEY)
    expect(applied.clearPaneState).toHaveBeenCalledWith(PANE_KEY)
    expect(applied.forward).not.toHaveBeenCalled()
    expect(applied.live).not.toHaveBeenCalled()
  })
})
