import { setImmediate as nextTurn } from 'node:timers/promises'
import { expect, it, vi } from 'vitest'
import { createAgentStatusExtensionHarness } from './agent-status-extension-test-harness'
import { postedHookNames, posts } from './agent-status-subagent-event-fixtures'

// #38570: omp auto-learn runs its capture tools after agent_end with no agent_start.
it('keeps an omp pane done while auto-learn capture tools run after the turn', async () => {
  const harness = createAgentStatusExtensionHarness({ kind: 'omp' })
  await harness.callHook('agent_start')
  await harness.callHook('agent_end', {})
  await harness.callHook('tool_call', { toolName: 'learn', input: {} })
  await harness.callHook('tool_execution_start', { toolName: 'learn', args: {} })
  await harness.callHook('tool_execution_end', { toolName: 'learn' })
  await nextTurn()
  expect(postedHookNames(harness).at(-1)).toBe('agent_end')

  await harness.callHook('agent_start')
  await harness.callHook('tool_call', { toolName: 'read', input: {} })
  await nextTurn()
  expect(postedHookNames(harness).at(-1)).toBe('tool_call')
})

it('reports an auto-learn capture approval as idle so the pane returns to done', async () => {
  const harness = createAgentStatusExtensionHarness({ kind: 'omp' })
  const approval = { toolName: 'manage_skill', approved: true }
  await harness.callHook('agent_start')
  await harness.callHook('tool_approval_resolved', approval)
  await vi.waitFor(() =>
    expect(posts(harness).at(-1)).toMatchObject({
      hook_event_name: 'tool_approval_resolved',
      is_idle: false
    })
  )

  await harness.callHook('agent_end', {})
  await harness.callHook('tool_approval_requested', { toolName: 'manage_skill' })
  await harness.callHook('tool_approval_resolved', approval)
  await vi.waitFor(() =>
    expect(posts(harness).at(-1)).toMatchObject({
      hook_event_name: 'tool_approval_resolved',
      is_idle: true
    })
  )

  await harness.callHook('agent_start')
  harness.emitPiEvent('task:subagent:lifecycle', { id: 'task-1', status: 'started' })
  await harness.callHook('agent_end', {})
  await harness.callHook('tool_approval_resolved', approval)
  await vi.waitFor(() =>
    expect(posts(harness).at(-1)).toMatchObject({
      hook_event_name: 'tool_approval_resolved',
      is_idle: false
    })
  )
})
