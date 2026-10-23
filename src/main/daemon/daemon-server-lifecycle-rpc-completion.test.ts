import { afterEach, expect, it, vi } from 'vitest'
import { DaemonEndpointLifecycle } from './daemon-endpoint-lifecycle'
import { createNoopDaemonFileLog } from './daemon-file-log'
import { DaemonServerLifecycle } from './daemon-server-lifecycle'
import { PROTOCOL_VERSION } from './types'

afterEach(() => vi.restoreAllMocks())

function fixture(disposeResources: () => Promise<void>) {
  const log = createNoopDaemonFileLog()
  const endpoint = new DaemonEndpointLifecycle({
    socketPath: '/unused',
    tokenPath: '/unused',
    pidPath: null,
    launchNonce: null,
    token: 'unused',
    publishEndpointOwnership: () => {},
    log,
    isServing: () => false,
    onOwnershipLost: () => {}
  })
  vi.spyOn(endpoint, 'unlinkOwnedArtifacts').mockImplementation(() => {})
  const complete = vi.fn()
  const lifecycle = new DaemonServerLifecycle({
    protocolVersion: PROTOCOL_VERSION,
    initialAdoptionTimeoutMs: 0,
    clock: { setTimeout: () => 0, clearTimeout: () => {}, now: () => 0 },
    endpoint,
    log,
    isIdle: () => false,
    disposeResources,
    onIdleShutdown: () => {},
    onRpcShutdown: complete,
    onShutdownRequested: () => {}
  })
  return { lifecycle, complete }
}

it('does not invoke hard completion when final lifecycle resource disposal rejects', async () => {
  const failure = new Error('resource disposal failed')
  const { lifecycle, complete } = fixture(async () => {
    throw failure
  })
  lifecycle.finishRpcShutdownWithoutReply(Promise.resolve(), 'verified-stalled-owner')
  await expect(lifecycle.shutdown()).rejects.toBe(failure)
  expect(complete).not.toHaveBeenCalled()
})

it('waits for both final resource disposal and socket closure before selecting hard completion', async () => {
  const resources = Promise.withResolvers<void>()
  const socketClosed = Promise.withResolvers<void>()
  const dispose = vi.fn(() => resources.promise)
  const { lifecycle, complete } = fixture(dispose)
  lifecycle.finishRpcShutdownWithoutReply(socketClosed.promise, 'verified-stalled-owner')
  expect(dispose).toHaveBeenCalledOnce()
  expect(complete).not.toHaveBeenCalled()
  resources.resolve()
  await resources.promise
  expect(complete).not.toHaveBeenCalled()
  socketClosed.resolve()
  await lifecycle.shutdown()
  expect(complete).toHaveBeenCalledExactlyOnceWith('verified-stalled-owner')
})
