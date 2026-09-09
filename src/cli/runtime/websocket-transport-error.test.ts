import { describe, expect, it, vi } from 'vitest'
import { RemoteRuntimeClientError } from '../../shared/remote-runtime-client-error'
import { orchestrationMutationRecoveryError } from '../orchestration-mutation-recovery'

const { sendRemoteRuntimeRequest, sendRemoteRuntimeRequestWithStatusPreflight } = vi.hoisted(
  () => ({
    sendRemoteRuntimeRequest: vi.fn(),
    sendRemoteRuntimeRequestWithStatusPreflight: vi.fn()
  })
)

vi.mock('../../shared/remote-runtime-client', () => ({
  RemoteRuntimeClientError,
  sendRemoteRuntimeRequest,
  sendRemoteRuntimeRequestWithStatusPreflight
}))

import {
  sendWebSocketRequest,
  sendWebSocketRequestWithStatusPreflight
} from './websocket-transport'

const pairing = {
  v: 2,
  endpoint: 'ws://127.0.0.1:1',
  deviceToken: 'token',
  publicKeyB64: 'key'
} as never

describe('CLI WebSocket transport error identity', () => {
  it('preserves recovery data from one-shot transport errors', async () => {
    sendRemoteRuntimeRequest.mockRejectedValueOnce(
      new RemoteRuntimeClientError('runtime_timeout', 'timed out', {
        data: {
          orchestrationRequestId: 'request_1',
          dispatchId: 'dispatch_1',
          originalCommand: ['orca', 'orchestration', 'worker-start', '--task', 'task_1']
        }
      })
    )

    try {
      await sendWebSocketRequest(pairing, 'orchestration.workerStart', {}, 100)
      throw new Error('expected transport failure')
    } catch (error) {
      expect(error).toMatchObject({
        code: 'runtime_timeout',
        data: {
          orchestrationRequestId: 'request_1',
          dispatchId: 'dispatch_1',
          originalCommand: ['orca', 'orchestration', 'worker-start', '--task', 'task_1']
        }
      })
      expect(orchestrationMutationRecoveryError(error)).toMatchObject({
        data: {
          recovery: {
            dispatchId: 'dispatch_1',
            queryCommand: [
              'orca',
              'orchestration',
              'worker-show',
              '--dispatch',
              'dispatch_1',
              '--json'
            ],
            retryCommand: [
              'orca',
              'orchestration',
              'worker-start',
              '--task',
              'task_1',
              '--retry-request',
              'request_1'
            ]
          }
        }
      })
    }
  })

  it('preserves recovery data through status-preflight transport errors', async () => {
    sendRemoteRuntimeRequestWithStatusPreflight.mockRejectedValueOnce(
      new RemoteRuntimeClientError('runtime_timeout', 'timed out', {
        data: { orchestrationRequestId: 'request_2' }
      })
    )

    await expect(
      sendWebSocketRequestWithStatusPreflight(
        pairing,
        'orchestration.workerStart',
        {},
        100,
        () => {}
      )
    ).rejects.toMatchObject({
      code: 'runtime_timeout',
      data: { orchestrationRequestId: 'request_2' }
    })
  })
})
