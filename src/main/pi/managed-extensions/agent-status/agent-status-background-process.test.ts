import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createAgentStatusExtensionHarness } from './agent-status-extension-test-harness'
import { agentEndCount, endTurn, posts } from './agent-status-subagent-event-fixtures'

describe('Pi background processes', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('keeps the pane working until a pi-processes job exits', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'pi' })
    await harness.callHook('session_start', { reason: 'startup' })
    await harness.callHook('agent_start')
    harness.emitPiEvent('processes:started', {
      id: 'proc_1',
      name: 'dev-server',
      command: 'pnpm dev'
    })
    await endTurn(harness)
    await vi.advanceTimersByTimeAsync(0)

    expect(agentEndCount(harness)).toBe(0)
    expect(posts(harness).at(-1)?.subagents).toMatchObject([
      { id: 'pi-process:proc_1', state: 'working', agentType: 'process' }
    ])

    harness.emitPiEvent('processes:ended', { id: 'proc_1', success: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(agentEndCount(harness)).toBe(1)
  })
})
