import { describe, expect, it, vi } from 'vitest'
import type { RuntimeClient } from '../../runtime-client'
import { ORCHESTRATION_WORKER_TERMINAL_HANDLERS } from './worker-terminal-handlers'

const RETRY_ID = '11111111-1111-4111-8111-111111111111'

describe('worker-reconcile-attachment CLI retry', () => {
  it('sends the same durable retry id on a repeated command', async () => {
    const call = vi.fn().mockResolvedValue({
      result: {
        dispatchId: 'ctx_abandoned',
        state: 'abandoned',
        processAction: 'none',
        alreadyReconciled: false,
        warning: 'The terminal process was not closed.'
      }
    })
    const client = { call } as unknown as RuntimeClient
    const invoke = () =>
      ORCHESTRATION_WORKER_TERMINAL_HANDLERS['orchestration worker-reconcile-attachment']({
        flags: new Map<string, string | boolean>([
          ['dispatch', 'ctx_abandoned'],
          ['retry-request', RETRY_ID]
        ]),
        client,
        cwd: 'C:\\folder-workspace\\cem-556',
        json: true
      })

    await invoke()
    await invoke()

    expect(call).toHaveBeenCalledTimes(2)
    for (const invocation of call.mock.calls) {
      expect(invocation[0]).toBe('orchestration.workerReconcileAttachment')
      expect(invocation[1]).toEqual({ dispatch: 'ctx_abandoned' })
      expect(invocation[2]).toMatchObject({ orchestrationRequestId: RETRY_ID })
    }
  })
})
