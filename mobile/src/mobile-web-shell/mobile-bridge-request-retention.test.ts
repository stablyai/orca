import { afterEach, expect, it, vi } from 'vitest'
import { BridgeHostRequests } from './bridge-host-requests'
import { createFakeRpcClient } from './bridge-host-test-fakes'
import { getRemoteRuntimeRequestAdmissionEvidence } from '../../../src/shared/remote-runtime/requests/remote-runtime-prepared-request-admission'

afterEach(() =>
  expect(getRemoteRuntimeRequestAdmissionEvidence()).toEqual({
    pendingRequestCount: 0,
    retainedBytes: 0
  })
)

it('retains actual bridge work through page cancellation, close and late native-post drain at N/10N', async () => {
  for (const count of [2, 20]) {
    const client = createFakeRpcClient()
    let releasePost!: () => void
    const post = new Promise<void>((resolve) => {
      releasePost = resolve
    })
    const sendReply = vi.fn(() => post)
    const sendError = vi.fn()
    const owner = new BridgeHostRequests({
      client,
      isIdTaken: () => false,
      sendReply,
      sendError,
      capExceeded: (message) => new Error(message),
      serveNative: async () => {
        throw new Error('Not native')
      },
      readClientIdentity: () => 'synthetic-caller'
    })
    const message = (id: number) => ({
      v: 1 as const,
      type: 'request' as const,
      id: String(id).padStart(22, '0'),
      method: 'agentSession.respondToApproval',
      params: { content: { value: 'x'.repeat(8192) } }
    })
    try {
      for (let index = 0; index < count; index++) {
        owner.open(message(index))
      }
      const admitted = getRemoteRuntimeRequestAdmissionEvidence()
      expect(client.requests).toHaveLength(count)
      expect(admitted.pendingRequestCount).toBe(count)
      expect(admitted.retainedBytes).toBe(
        count * (8 * JSON.stringify(message(0)).length + 64 * 1024)
      )
      owner.cancel(message(0).id)
      expect(getRemoteRuntimeRequestAdmissionEvidence()).toEqual(admitted)
      for (const request of client.requests) {
        request.resolve({ id: 'wire', ok: true, result: { complete: 'y'.repeat(8192) } })
      }
      await Promise.resolve()
      await Promise.resolve()
      expect(sendReply).toHaveBeenCalledTimes(count - 1)
      await vi.waitFor(() =>
        expect(getRemoteRuntimeRequestAdmissionEvidence().pendingRequestCount).toBe(count - 1)
      )
      owner.closeAll(false)
      expect(getRemoteRuntimeRequestAdmissionEvidence().pendingRequestCount).toBe(count - 1)
      releasePost()
      await vi.waitFor(() =>
        expect(getRemoteRuntimeRequestAdmissionEvidence()).toEqual({
          pendingRequestCount: 0,
          retainedBytes: 0
        })
      )
      expect(sendError).not.toHaveBeenCalled()
      console.info('bridge production ownership operations', {
        count,
        forwards: client.requests.length,
        posts: sendReply.mock.calls.length
      })
    } finally {
      owner.closeAll(false)
      releasePost()
      await vi.waitFor(() =>
        expect(getRemoteRuntimeRequestAdmissionEvidence().pendingRequestCount).toBe(0)
      )
    }
  }
})
