import { describe, expect, it, vi } from 'vitest'

import { createAgentStatusExtensionHarness } from './agent-status-extension-test-harness'

// Shape captured from omp 17.0.5: `approvalMode` is the ambient tools.approvalMode
// (always-ask | write | yolo), and `reason` is the tool's own override reason.
const APPROVAL_REQUEST = {
  toolName: 'bash',
  reason: 'Critical pattern detected',
  approvalMode: 'always-ask'
}

const APPROVAL_STATUS_ENV = { ORCA_OMP_APPROVAL_STATUS: '1' }

const OMP_RUNTIME_CASES = [
  ['configured OMP', { kind: 'omp' as const }],
  ['title-routed OMP', { kind: 'pi' as const, title: 'omp' }],
  ['argv-routed OMP', { kind: 'pi' as const, argv: ['node', '/usr/local/bin/omp'] }]
] as const

// Why: OMP 18.4.3 refuses speculative task launch and speculative reads while any
// extension has one of these handlers ("active extension lifecycle handler").
const SPECULATION_BLOCKING_EVENTS = [
  'tool_call',
  'tool_result',
  'tool_approval_requested',
  'tool_approval_resolved'
]

describe('OMP approval forwarding', () => {
  it.each(OMP_RUNTIME_CASES)(
    'registers no handler that disables speculative launch on %s by default',
    (_name, args) => {
      const harness = createAgentStatusExtensionHarness(args)

      for (const name of SPECULATION_BLOCKING_EVENTS) {
        expect(harness.handlers[name], name).toBeUndefined()
      }
      expect(harness.handlers.tool_execution_start).toBeTypeOf('function')
    }
  )

  it.each(OMP_RUNTIME_CASES)(
    'posts tool_approval_requested and resolved from %s once opted in',
    async (_name, args) => {
      const harness = createAgentStatusExtensionHarness({ ...args, env: APPROVAL_STATUS_ENV })

      expect(harness.handlers.tool_call).toBeUndefined()
      expect(harness.handlers.tool_result).toBeUndefined()

      await harness.callHook('tool_approval_requested', APPROVAL_REQUEST)
      await vi.waitFor(() => expect(harness.fetchMock).toHaveBeenCalledTimes(1))
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
    }
  )

  it('does not post OMP approval events from a genuine Pi process', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'pi', env: APPROVAL_STATUS_ENV })

    expect(harness.handlers.tool_approval_requested).toBeTypeOf('function')
    await harness.callHook('tool_approval_requested', APPROVAL_REQUEST)
    expect(harness.fetchMock).not.toHaveBeenCalled()
  })

  it.each(['pi', 'prime-agent'] as const)('keeps posting tool_call from %s', async (kind) => {
    const harness = createAgentStatusExtensionHarness({ kind })

    await harness.callHook('tool_call', { toolName: 'bash', input: { command: 'ls' } })

    await vi.waitFor(() => expect(harness.fetchMock).toHaveBeenCalledTimes(1))
    expect(JSON.parse(String(harness.fetchMock.mock.calls[0]?.[1]?.body)).payload).toMatchObject({
      hook_event_name: 'tool_call',
      tool_name: 'bash',
      tool_input: { command: 'ls' }
    })
  })

  it('does not register OMP approval handlers on Prime', () => {
    const harness = createAgentStatusExtensionHarness({
      kind: 'prime-agent',
      env: APPROVAL_STATUS_ENV
    })

    expect(harness.handlers.tool_approval_requested).toBeUndefined()
    expect(harness.handlers.tool_approval_resolved).toBeUndefined()
  })
})
