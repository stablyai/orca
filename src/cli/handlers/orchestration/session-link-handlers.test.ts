import { describe, expect, it, vi } from 'vitest'
import { RuntimeClientError, RuntimeRpcFailureError } from '../../runtime-client'
import { orchestrationTestContext } from '../orchestration-handler-test-context'
import { ORCHESTRATION_LINK_HANDLERS } from './session-link-handlers'

describe('link operation recovery errors', () => {
  for (const command of ['link-send', 'link-control']) {
    it.each(['client', 'rpc'])(`preserves %s error codes and data for ${command}`, async (kind) => {
      const data = { effectsApplied: false, recovery: { query: 'inspect' } }
      const error =
        kind === 'rpc'
          ? new RuntimeRpcFailureError({
              id: 'refusal',
              ok: false,
              error: { code: 'session_link_refused', message: 'Refused', data }
            })
          : new RuntimeClientError('runtime_timeout', 'Reply lost', data)
      const call = vi.fn().mockRejectedValue(error)
      const context = orchestrationTestContext(
        call,
        new Map([
          ['id', 'pair'],
          ['body', 'Report'],
          ['action', 'end'],
          ['operation', 'retry-op'],
          ['turn-operation', 'delivery-op']
        ]),
        true
      )
      await expect(
        ORCHESTRATION_LINK_HANDLERS[`orchestration ${command}`](context)
      ).rejects.toMatchObject({
        code: error.code,
        data,
        message: expect.stringContaining('--operation retry-op')
      })
    })
  }
})
