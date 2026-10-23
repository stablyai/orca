import { beforeEach, expect, it, vi } from 'vitest'
import type { subscribeRuntimeEnvironment } from './runtime-environment-transport-routing'

const mocks = vi.hoisted(() => ({ handle: vi.fn(), on: vi.fn(), subscribe: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle: mocks.handle, on: mocks.on } }))
vi.mock('../../../shared/runtime-environment-store', () => ({
  resolveEnvironment: () => ({ id: 'env', pairingRevision: 1, createdAt: 1 })
}))
vi.mock('./runtime-environment-transport-routing', () => ({
  subscribeRuntimeEnvironment: mocks.subscribe
}))
import { advanceRuntimeEnvironmentTransportGeneration } from './runtime-environment-transport-generation'
import {
  registerRuntimeEnvironmentSubscriptionHandlers,
  type PendingRuntimeSubscription,
  type RetainedRemoteRuntimeSubscription
} from './runtime-environment-subscription-handlers'

type Callbacks = Parameters<typeof subscribeRuntimeEnvironment>[5]

const sender = {
  id: 1,
  isDestroyed: () => false,
  send: vi.fn(),
  once: vi.fn(),
  removeListener: vi.fn()
}
const recordLayoutFrame = vi.fn()
const census = {
  id: 'stream',
  ok: true as const,
  result: { type: 'snapshots', snapshots: [] },
  _meta: { runtimeId: 'server' }
}

async function open(method: string): Promise<Callbacks> {
  let callbacks: Callbacks | undefined
  mocks.subscribe.mockImplementationOnce(
    async (...parameters: Parameters<typeof subscribeRuntimeEnvironment>) => {
      callbacks = parameters[5]
      return { requestId: 'request', sendBinary: vi.fn(() => true), close: vi.fn() }
    }
  )
  const subscribe = mocks.handle.mock.calls.find(
    ([name]) => name === 'runtimeEnvironments:subscribe'
  )![1]
  await subscribe({ sender }, { selector: 'env', method, subscriptionId: method })
  return callbacks!
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.subscribe.mockReset()
  registerRuntimeEnvironmentSubscriptionHandlers({
    getUserDataPath: () => '/profile',
    remoteRuntimeSubscriptions: new Map<string, RetainedRemoteRuntimeSubscription>(),
    pendingSubscriptions: new Map<string, PendingRuntimeSubscription>(),
    recordLayoutFrame
  })
})

it('records the window’s own stream after forwarding it unchanged, opening nothing new', async () => {
  const callbacks = await open('session.tabs.subscribeAll')
  callbacks.onEvent({ type: 'response', response: census })

  // The window's subscription is the only request the server sees.
  expect(mocks.subscribe).toHaveBeenCalledOnce()
  expect(mocks.subscribe.mock.calls[0]?.[2]).toBe('session.tabs.subscribeAll')
  expect(sender.send).toHaveBeenCalledExactlyOnceWith('runtimeEnvironments:subscriptionEvent', {
    subscriptionId: 'session.tabs.subscribeAll',
    type: 'response',
    response: census
  })
  expect(recordLayoutFrame).toHaveBeenCalledExactlyOnceWith(
    'env',
    'session.tabs.subscribeAll',
    census
  )
  expect(sender.send.mock.invocationCallOrder[0]).toBeLessThan(
    recordLayoutFrame.mock.invocationCallOrder[0]!
  )
})

it('offers the recorder only frames the window was sent', async () => {
  const callbacks = await open('session.tabs.subscribeAll')
  callbacks.onEvent({ type: 'binary', bytes: new Uint8Array([1]) })
  callbacks.onEvent({ type: 'error', code: 'lost', message: 'lost' })
  // A replaced transport's late frame reaches neither the window nor the snapshot.
  advanceRuntimeEnvironmentTransportGeneration('env')
  sender.send.mockClear()
  callbacks.onEvent({ type: 'response', response: census })
  expect(sender.send).not.toHaveBeenCalled()
  expect(recordLayoutFrame).not.toHaveBeenCalled()
})
