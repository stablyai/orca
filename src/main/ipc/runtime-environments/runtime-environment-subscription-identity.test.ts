import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RemoteRuntimeSubscription } from '../../../shared/remote-runtime/remote-runtime-client'
import type * as RuntimeEnvironmentStore from '../../../shared/runtime-environment-store'
import type { subscribeRuntimeEnvironment } from './runtime-environment-transport-routing'

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  on: vi.fn(),
  subscribe: vi.fn(),
  resolve: vi.fn()
}))
vi.mock('electron', () => ({ ipcMain: { handle: mocks.handle, on: mocks.on } }))
vi.mock('../../../shared/runtime-environment-store', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeEnvironmentStore>()),
  resolveEnvironment: mocks.resolve
}))
vi.mock('./runtime-environment-transport-routing', () => ({
  subscribeRuntimeEnvironment: mocks.subscribe
}))
import {
  registerRuntimeEnvironmentSubscriptionHandlers,
  type PendingRuntimeSubscription,
  type RetainedRemoteRuntimeSubscription
} from './runtime-environment-subscription-handlers'

const remoteRuntimeSubscriptions = new Map<string, RetainedRemoteRuntimeSubscription>()
const pendingSubscriptions = new Map<string, PendingRuntimeSubscription>()

type Callbacks = Parameters<typeof subscribeRuntimeEnvironment>[5]
const sender = Object.assign(new EventEmitter(), {
  id: 1,
  mainFrame: { detached: false },
  isDestroyed: () => false,
  send: vi.fn()
})
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
  mocks.resolve
    .mockReset()
    .mockReturnValue({ id: 'env', pairingRevision: 1, createdAt: 1, runtimeId: null })
  registerRuntimeEnvironmentSubscriptionHandlers({
    getUserDataPath: () => '/profile',
    remoteRuntimeSubscriptions,
    pendingSubscriptions,
    recordLayoutFrame: vi.fn()
  })
})
afterEach(() => {
  for (const pending of pendingSubscriptions.values()) {
    pending.close()
  }
  pendingSubscriptions.clear()
  for (const subscription of remoteRuntimeSubscriptions.values()) {
    subscription.close()
  }
  remoteRuntimeSubscriptions.clear()
})

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
  expect(connections[0].close).toHaveBeenCalledOnce()
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
  await expect(open()).resolves.toMatchObject({ subscriptionId: 'reused-id' })
  expect(sender.send).toHaveBeenCalledWith('runtimeEnvironments:subscriptionEvent', {
    subscriptionId: 'reused-id',
    type: 'close'
  })
  expect(value.close).toHaveBeenCalledOnce()
  mocks.subscribe.mockResolvedValueOnce(connection())
  await expect(open()).resolves.toMatchObject({ subscriptionId: 'reused-id' })
})

it('releases open and pending streams across five reloads of the same WebContents', async () => {
  for (let reload = 0; reload < 5; reload++) {
    const active = connection()
    const late = connection()
    const setup = Promise.withResolvers<RemoteRuntimeSubscription>()
    mocks.subscribe.mockResolvedValueOnce(active).mockReturnValueOnce(setup.promise)
    await open()
    const pending = handler('runtimeEnvironments:subscribe')(
      { sender },
      { ...args, subscriptionId: 'pending' }
    )
    const signal: AbortSignal = mocks.subscribe.mock.lastCall![7]
    expect(remoteRuntimeSubscriptions.size).toBe(1)
    expect(pendingSubscriptions.size).toBe(1)

    sender.emit('did-navigate', {}, 'file:///app', 200, 'OK')
    expect(signal.aborted).toBe(true)
    expect(active.close).toHaveBeenCalledOnce()
    setup.resolve(late)
    await pending
    expect(late.close).toHaveBeenCalledOnce()
    expect(remoteRuntimeSubscriptions.size).toBe(0)
    expect(pendingSubscriptions.size).toBe(0)
    expect(sender.eventNames()).toEqual([])
  }
  mocks.subscribe.mockResolvedValueOnce(connection())
  await open()
  expect(remoteRuntimeSubscriptions.size).toBe(1)
})

const crewArgs = {
  selector: 'env',
  method: 'orchestration.crewSubscribe',
  subscriptionId: 'crew',
  setupResult: 'crew',
  expectedEnvironmentPairingRevision: 1,
  expectedEnvironmentRuntimeId: null
} as const
const openCrew = () =>
  handler('runtimeEnvironments:subscribe')({ sender, senderFrame: sender.mainFrame }, crewArgs)

it('returns normal crew setup as plain data and keeps the default original Error', async () => {
  const original = new Error('coarse local preparation failed')
  mocks.subscribe.mockRejectedValue(original)
  const failure = await openCrew()
  expect(failure).toEqual({
    subscriptionId: 'crew',
    ok: false,
    failure: { message: original.message, fact: { kind: 'operation', operation: 'subscription' } }
  })
  expect(structuredClone(failure)).toEqual(failure)
  await expect(open()).rejects.toBe(original)
  expect(pendingSubscriptions.size).toBe(0)
  expect(sender.eventNames()).toEqual([])
  mocks.subscribe.mockResolvedValueOnce(connection())
  await expect(openCrew()).resolves.toEqual({ subscriptionId: 'crew', ok: true })
  expect(remoteRuntimeSubscriptions.size).toBe(1)
})

it('reserves crew before await, rejects wrong-owner cancellation, and closes the actual late handle', async () => {
  const held = Promise.withResolvers<RemoteRuntimeSubscription>()
  mocks.subscribe.mockReturnValue(held.promise)
  const pending = openCrew()
  expect(pendingSubscriptions.size).toBe(1)
  await expect(openCrew()).resolves.toMatchObject({
    ok: false,
    failure: { fact: { kind: 'input' } }
  })
  const cancel = handler('runtimeEnvironments:unsubscribe')
  expect(cancel({ sender: { id: 2 } }, { subscriptionId: 'crew' })).toEqual({ unsubscribed: false })
  expect(pendingSubscriptions.size).toBe(1)
  expect(cancel({ sender }, { subscriptionId: 'crew' })).toEqual({ unsubscribed: true })
  expect(pendingSubscriptions.size).toBe(0)
  const late = connection()
  held.resolve(late)
  await expect(pending).resolves.toMatchObject({
    ok: false,
    failure: { fact: { kind: 'cancelled' } }
  })
  expect(late.close).toHaveBeenCalledOnce()
  expect(remoteRuntimeSubscriptions.size).toBe(0)
  expect(sender.eventNames()).toEqual([])
})
