import { setImmediate as nextTurn } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'

import {
  createAgentStatusExtensionHarness,
  type AgentStatusExtensionHarness
} from './agent-status-extension-test-harness'

function lastPostedHookName(harness: AgentStatusExtensionHarness): string {
  const body = JSON.parse(String(harness.fetchMock.mock.calls.at(-1)?.[1]?.body))
  return body.payload.hook_event_name
}

// omp's auto-learn capture runs tools after agent_end; reporting them would reopen a done pane.
describe('OMP auto-learn capture', () => {
  it('keeps the pane done during the capture but reports a turn that starts meanwhile', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'omp' })

    await harness.callHook('agent_start')
    await harness.callHook('autolearn_capture_start')
    await harness.callHook('agent_end', {})
    await harness.callHook('tool_execution_start', { toolName: 'learn', args: {} })
    await nextTurn()
    expect(lastPostedHookName(harness)).toBe('agent_end')

    await harness.callHook('agent_start')
    await harness.callHook('tool_execution_start', { toolName: 'read', args: {} })
    await nextTurn()
    expect(lastPostedHookName(harness)).toBe('tool_execution_start')
  })
})
