import { RemoteRuntimeSharedControlConnection } from '../../../../shared/remote-runtime/control/remote-runtime-shared-control-connection'
import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  closeSharedControlTestServers,
  createSharedControlTestServer
} from '../../../../shared/remote-runtime/control/remote-runtime-shared-control-test-server'
import { resetRuntimeEnvironmentCapabilityEvidence } from './runtime-environment-capability-evidence'
import { clearRuntimeEnvironmentManualDisconnect } from '../connectivity/runtime-environment-manual-disconnect'
import {
  closeRemoteRuntimeRequestConnection,
  sendRemoteRuntimeSharedControlRequestOnRuntime
} from './runtime-environment-request-connections'

const ENVIRONMENT_ID = 'standing-intent-test'

afterEach(async () => {
  vi.restoreAllMocks()
  closeRemoteRuntimeRequestConnection(ENVIRONMENT_ID)
  clearRuntimeEnvironmentManualDisconnect(ENVIRONMENT_ID)
  resetRuntimeEnvironmentCapabilityEvidence()
  await closeSharedControlTestServers()
})

describe('runtime environment shared-control connection cache', () => {
  it.each([
    ['the probed runtime', 'runtime-a', true],
    ['a replacement runtime behind the same endpoint', 'runtime-b', false]
  ])(
    'sends a runtime-pinned call only when its socket reached %s',
    async (_label, reached, sent) => {
      const server = await createSharedControlTestServer({
        resultForRequest: (method) =>
          method === 'status.get' ? { runtimeId: reached } : { method }
      })

      const response = await sendRemoteRuntimeSharedControlRequestOnRuntime(
        ENVIRONMENT_ID,
        server.pairing,
        { method: 'files.write', params: { relativePath: 'a.ts' }, timeoutMs: 1000 },
        'runtime-a'
      )

      expect(response === null).toBe(!sent)
      expect(server.requests.some((request) => request.method === 'files.write')).toBe(sent)
    }
  )

  it('does not dispatch create after the preflight socket is replaced', async () => {
    const closed = Promise.withResolvers<void>()
    const server = await createSharedControlTestServer({
      onClientClose: () => closed.resolve(),
      resultForRequest: (method) => (method === 'status.get' ? { runtimeId: 'runtime-a' } : {})
    })
    const original = RemoteRuntimeSharedControlConnection.prototype.request
    vi.spyOn(RemoteRuntimeSharedControlConnection.prototype, 'request').mockImplementation(
      function <TResult>(
        this: RemoteRuntimeSharedControlConnection,
        ...args: Parameters<typeof original>
      ): Promise<RuntimeRpcResponse<TResult>> {
        const invoke = original.bind(this)
        const response = invoke<TResult>(...args)
        if (args[0] !== 'status.get') {
          return response
        }
        return response.then(async (status) => {
          server.closeClients()
          await closed.promise
          this.reconnectNow()
          return status
        })
      }
    )
    await expect(
      sendRemoteRuntimeSharedControlRequestOnRuntime(
        ENVIRONMENT_ID,
        server.pairing,
        {
          method: 'agentSession.create',
          params: {
            forkFrom: { sessionId: 'child', throughItemId: 'legacy:opencode:source:reply-1' }
          },
          timeoutMs: 1000
        },
        'runtime-a'
      )
    ).resolves.toBeNull()
    expect(server.requests.filter((request) => request.method === 'agentSession.create')).toEqual(
      []
    )
  })
})
