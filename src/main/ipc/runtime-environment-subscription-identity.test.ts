import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RemoteRuntimeSubscription } from '../../shared/remote-runtime-client'
import type { subscribeRuntimeEnvironment } from './runtime-environment-transport-routing'
import { advanceRuntimeEnvironmentTransportGeneration } from './runtime-environment-transport-generation'

const mocks = vi.hoisted(() => ({ handle: vi.fn(), on: vi.fn(), subscribe: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle: mocks.handle, on: mocks.on } }))
vi.mock('../../shared/runtime-environment-store', () => ({
  resolveEnvironment: () => ({ id: 'env', pairingRevision: 1, createdAt: 1 })
}))
vi.mock('./runtime-environment-transport-routing', () => ({
  subscribeRuntimeEnvironment: mocks.subscribe
}))
import {
  closeSubscriptionsForEnvironment,
  registerRuntimeEnvironmentSubscriptions
} from './runtime-environment-subscriptions'

type Callbacks = Parameters<typeof subscribeRuntimeEnvironment>[5]
const sender = {
  id: 1,
  isDestroyed: () => false,
  send: vi.fn(),
  once: vi.fn(),
  removeListener: vi.fn()
}
const args = { selector: 'env', method: 'terminal.multiplex', subscriptionId: 'reused-id' }
function handler(channel: string) {
  return mocks.handle.mock.calls.find(([name]) => name === channel)![1]
}
const open = () => handler('runtimeEnvironments:subscribe')({ sender }, args)
const unsubscribe = () =>
  handler('runtimeEnvironments:unsubscribe')({ sender }, { subscriptionId: args.subscriptionId })
const connection = (): RemoteRuntimeSubscription => ({
  requestId: 'request',
  sendBinary: vi.fn(() => true),
  close: vi.fn()
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.subscribe.mockReset()
  registerRuntimeEnvironmentSubscriptions(() => '/profile')
})
afterEach(() => closeSubscriptionsForEnvironment('env'))

it('reserves an ID while setup is pending so a second open cannot take its ownership', async () => {
  const gate = Promise.withResolvers<RemoteRuntimeSubscription>()
  mocks.subscribe.mockReturnValue(gate.promise)
  const first = open()
  await expect(open()).rejects.toThrow('already exists')
  expect(mocks.subscribe).toHaveBeenCalledOnce()
  gate.resolve(connection())
  await expect(first).resolves.toMatchObject({ subscriptionId: 'reused-id' })
})

it('releases the reservation after failed setup so an explicit retry can open', async () => {
  mocks.subscribe.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(connection())
  await expect(open()).rejects.toThrow('offline')
  await expect(open()).resolves.toMatchObject({ subscriptionId: 'reused-id' })
})

it('does not let callbacks from an old subscription publish to or remove its replacement', async () => {
  const callbacks: Callbacks[] = []
  const currentChecks: (() => boolean)[] = []
  const connections: RemoteRuntimeSubscription[] = []
  mocks.subscribe.mockImplementation(
    async (...parameters: Parameters<typeof subscribeRuntimeEnvironment>) => {
      callbacks.push(parameters[5])
      currentChecks.push(parameters[6]!)
      const value = connection()
      connections.push(value)
      return value
    }
  )
  await open()
  expect(unsubscribe()).toEqual({ unsubscribed: true })
  await open()
  sender.send.mockClear()
  expect(currentChecks[0]()).toBe(false)
  expect(currentChecks[1]()).toBe(true)
  const payload = { type: 'binary' as const, bytes: new Uint8Array([1]) }
  callbacks[0].onEvent(payload)
  callbacks[0].onEvent({ type: 'close' })
  callbacks[0].onClose()
  expect(sender.send).not.toHaveBeenCalled()
  callbacks[1].onEvent(payload)
  expect(sender.send).toHaveBeenCalledWith('runtimeEnvironments:subscriptionEvent', {
    subscriptionId: 'reused-id',
    ...payload
  })
  expect(unsubscribe()).toEqual({ unsubscribed: true })
  expect(connections[1].close).toHaveBeenCalledOnce()
})

it('does not retain a subscription that closes before setup resolves', async () => {
  const value = connection()
  mocks.subscribe.mockImplementationOnce(
    async (...parameters: Parameters<typeof subscribeRuntimeEnvironment>) => {
      parameters[5].onEvent({ type: 'close' })
      parameters[5].onClose()
      return value
    }
  )
  await expect(open()).rejects.toThrow('closed during setup')
  expect(value.close).toHaveBeenCalledOnce()
  mocks.subscribe.mockResolvedValueOnce(connection())
  await expect(open()).resolves.toMatchObject({ subscriptionId: 'reused-id' })
})

it.each(['terminal.subscribe', 'terminal.multiplex', 'browser.screencast'])(
  'preserves the exact %s socket and its binary input across a control-only transition',
  async (method) => {
    const value = connection()
    let callbacks: Callbacks
    let isCurrent: () => boolean
    mocks.subscribe.mockImplementationOnce(
      async (...parameters: Parameters<typeof subscribeRuntimeEnvironment>) => {
        callbacks = parameters[5]
        isCurrent = parameters[6]!
        return value
      }
    )
    await handler('runtimeEnvironments:subscribe')({ sender }, { ...args, method })
    advanceRuntimeEnvironmentTransportGeneration('env', 'resource')
    closeSubscriptionsForEnvironment('env', { preserveResourceStreams: true })
    advanceRuntimeEnvironmentTransportGeneration('env')
    expect(value.close).not.toHaveBeenCalled()
    expect(sender.send).not.toHaveBeenCalled()
    expect(isCurrent!()).toBe(true)
    const bytes = new Uint8Array([7, 1, 2])
    mocks.on.mock.calls.find(
      ([channel]) => channel === 'runtimeEnvironments:subscriptionBinary'
    )![1]({ sender }, { subscriptionId: 'reused-id', bytes })
    expect(value.sendBinary).toHaveBeenCalledExactlyOnceWith(bytes)
    callbacks!.onEvent({ type: 'binary', bytes })
    expect(sender.send).toHaveBeenCalledOnce()
    expect(mocks.subscribe).toHaveBeenCalledOnce()
    closeSubscriptionsForEnvironment('env')
    expect(value.close).toHaveBeenCalledOnce()
    expect(isCurrent!()).toBe(false)
  }
)

it('still retires control subscriptions during a resource-preserving transition', async () => {
  const value = connection()
  mocks.subscribe.mockResolvedValueOnce(value)
  await handler('runtimeEnvironments:subscribe')(
    { sender },
    { ...args, method: 'session.tabs.subscribeAll' }
  )
  advanceRuntimeEnvironmentTransportGeneration('env')
  closeSubscriptionsForEnvironment('env', { preserveResourceStreams: true })
  expect(value.close).toHaveBeenCalledOnce()
  expect(unsubscribe()).toEqual({ unsubscribed: false })
})
