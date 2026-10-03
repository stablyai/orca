import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodePairingOffer } from '../../shared/pairing'
import { addEnvironmentFromPairingCode } from '../../shared/runtime-environment-store'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'

const { sendRequest } = vi.hoisted(() => ({ sendRequest: vi.fn() }))
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('../../shared/remote-runtime-client', () => ({ sendRemoteRuntimeRequest: sendRequest }))
vi.mock('./runtime-environment-request-connections', async () => {
  const { withRuntimeStatusOwners } = await import('./runtime-environments-ipc-test-harness')
  return withRuntimeStatusOwners({
    sendRemoteRuntimeConnectionRequest: vi.fn(),
    sendRemoteRuntimeSharedControlRequest: vi.fn(),
    reconnectRemoteRuntimeSharedControlConnection: vi.fn(),
    retryRemoteRuntimeSharedControlConnectionNow: vi.fn(),
    ensureRemoteRuntimeSharedControlConnection: vi.fn(),
    pauseRemoteRuntimeSharedControlRetry: vi.fn()
  })
})
import { callRuntimeEnvironment } from './runtime-environment-transport-routing'
import { resetRuntimeEnvironmentStatusOwners } from './runtime-environment-request-connections'

let userDataPath: string
let environmentId: string
let release: () => void
let blockers: Promise<RuntimeRpcResponse<unknown>>[]

function enqueueOwnedPayload(): { refs: WeakRef<object>[]; settled: Promise<unknown> } {
  const params = { content: 'x'.repeat(1024 * 1024) }
  const envelope = { orchestrationRequestId: 'request-1' }
  return {
    refs: [new WeakRef(params), new WeakRef(envelope)],
    settled: callRuntimeEnvironment(
      userDataPath,
      environmentId,
      'files.write',
      params,
      undefined,
      undefined,
      envelope
    )
  }
}

describe('desktop runtime queued payload admission', () => {
  beforeEach(async () => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-queue-bytes-'))
    environmentId = addEnvironmentFromPairingCode(userDataPath, {
      name: 'host',
      pairingCode: encodePairingOffer({
        v: 2,
        endpoint: 'ws://127.0.0.1:6768',
        deviceToken: 'token',
        publicKeyB64: Buffer.alloc(32, 1).toString('base64')
      })
    }).id
    const blocked = new Promise<RuntimeRpcResponse<unknown>>((resolve) => {
      release = () => resolve({ id: 'write', ok: true, result: null, _meta: { runtimeId: 'host' } })
    })
    sendRequest.mockReset().mockImplementation((_pairing: unknown, method: string) =>
      method === 'status.get'
        ? Promise.resolve({
            id: 'status',
            ok: true,
            result: { capabilities: [] },
            _meta: { runtimeId: 'host' }
          })
        : blocked
    )
    blockers = Array.from({ length: 8 }, () =>
      callRuntimeEnvironment(userDataPath, environmentId, 'files.write', {})
    )
    await vi.waitFor(() =>
      expect(sendRequest.mock.calls.filter((call) => call[1] === 'files.write')).toHaveLength(8)
    )
  })

  afterEach(async () => {
    release()
    await Promise.allSettled(blockers)
    resetRuntimeEnvironmentStatusOwners()
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it.each(['params', 'envelope'])(
    'charges queued %s before a transport request starts',
    async (field) => {
      const send = (): Promise<unknown> =>
        callRuntimeEnvironment(
          userDataPath,
          environmentId,
          'files.write',
          field === 'params' ? { content: 'x'.repeat(2 * 1024 * 1024) } : {},
          undefined,
          undefined,
          field === 'envelope'
            ? { orchestrationCapability: 'x'.repeat(2 * 1024 * 1024) }
            : undefined
        )
      const queued = Array.from({ length: 5 }, send)
      let rejection: unknown
      const overflow = send().catch((error: unknown) => {
        rejection = error
      })
      try {
        await new Promise<void>((resolve) => setImmediate(resolve))
        expect(rejection).toMatchObject({ code: 'runtime_rpc_queue_overloaded', scope: 'memory' })
        expect(sendRequest.mock.calls.filter((call) => call[1] === 'files.write')).toHaveLength(8)
      } finally {
        release()
        await Promise.allSettled([...queued, overflow])
      }
      await expect(send()).resolves.toMatchObject({ ok: true })
    }
  )

  it('releases original params and authority envelope while waiting for a queue slot', async () => {
    const queued = enqueueOwnedPayload()
    try {
      if (!('gc' in globalThis) || typeof globalThis.gc !== 'function') {
        throw new Error('The test runner must enable --expose-gc')
      }
      for (let round = 0; round < 3; round += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve))
        globalThis.gc()
      }
      expect(queued.refs.every((ref) => ref.deref() === undefined)).toBe(true)
    } finally {
      release()
      await queued.settled
    }
  })
})
