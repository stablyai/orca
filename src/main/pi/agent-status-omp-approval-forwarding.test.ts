import { describe, expect, it, vi } from 'vitest'

import { createAgentStatusExtensionHarness } from './agent-status-extension-test-harness'

// Shape captured from omp 17.0.5: `approvalMode` is the ambient tools.approvalMode
// (always-ask | write | yolo), and `reason` is the tool's own override reason.
const APPROVAL_REQUEST = {
  toolName: 'bash',
  reason: 'Critical pattern detected',
  approvalMode: 'always-ask'
}

describe('OMP approval forwarding', () => {
  it.each([
    ['configured OMP', { kind: 'omp' as const }],
    ['title-routed OMP', { kind: 'pi' as const, title: 'omp' }],
    ['argv-routed OMP', { kind: 'pi' as const, argv: ['node', '/usr/local/bin/omp'] }]
  ])('posts tool_approval_requested and resolved from %s', async (_name, args) => {
    const harness = createAgentStatusExtensionHarness(args)

    expect(harness.handlers.tool_approval_requested).toBeTypeOf('function')
    expect(harness.handlers.tool_approval_resolved).toBeTypeOf('function')

    await harness.callHook('tool_approval_requested', APPROVAL_REQUEST)
    await harness.callHook('tool_approval_resolved', { toolName: 'bash', approved: true })

    await vi.waitFor(() => expect(harness.fetchMock).toHaveBeenCalledTimes(2))
    expect(harness.fetchMock.mock.calls[0]?.[0]).toBe('http://127.0.0.1:4321/hook/omp')
    expect(
      harness.fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).payload)
    ).toEqual([
      {
        hook_event_name: 'tool_approval_requested',
        tool_name: 'bash',
        reason: 'Critical pattern detected',
        approval_mode: 'always-ask'
      },
      {
        hook_event_name: 'tool_approval_resolved',
        tool_name: 'bash',
        approved: true
      }
    ])
  })

  it('does not post OMP approval events from a genuine Pi process', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'pi' })

    expect(harness.handlers.tool_approval_requested).toBeTypeOf('function')
    await harness.callHook('tool_approval_requested', APPROVAL_REQUEST)
    expect(harness.fetchMock).not.toHaveBeenCalled()
  })

  it('does not register OMP approval handlers on Prime', () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'prime-agent' })

    expect(harness.handlers.tool_approval_requested).toBeUndefined()
    expect(harness.handlers.tool_approval_resolved).toBeUndefined()
  })
})
