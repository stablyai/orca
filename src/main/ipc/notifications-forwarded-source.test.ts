import { findForwardedPushSource } from './runtime-environments/runtime-environment-subscription-source'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { app } from 'electron'
import {
  handleMock,
  createNotificationStore,
  createNotificationRuntime,
  getDispatchHandler,
  resetNotificationDispatchMocks
} from './notifications-test-harness'
import type { subscribeRuntimeEnvironment } from './runtime-environments/runtime-environment-transport-routing'
import type {
  RuntimeRpcResponse,
  RuntimeSubscriptionContext
} from '../../shared/runtime-rpc-envelope'
import type { NotificationDispatchRequest } from '../../shared/notification-settings-types'
import type { RemoteRuntimeSubscription } from '../../shared/remote-runtime/remote-runtime-client'
import {
  createEnvironmentFromPairingOffer,
  getPreferredPairedRuntimeConnection
} from '../../shared/runtime-environments'
import { resolveEnvironment } from '../../shared/runtime-environment-store'
import { deriveRelayHostId } from '../runtime/mobile-cloud-relay/relay-http-client'
import { subscribeRuntimeEnvironmentFromPreload } from '../../preload/runtime-environment-subscriptions'
import { subscribeRuntimeRpc } from '../../renderer/src/runtime/runtime-rpc-subscribe'
import { registerNotificationHandlers } from './notifications'
import { registerRuntimeEnvironmentSubscriptionHandlers } from './runtime-environments/runtime-environment-subscription-handlers'
import type {
  PendingRuntimeSubscription,
  RetainedRemoteRuntimeSubscription
} from './runtime-environments/runtime-environment-subscription-source'
function required<T>(get: () => T | undefined): T {
  const value = get()
  if (value === undefined) {
    throw new Error('Missing captured transport callback')
  }
  return value
}
const transport = vi.hoisted(() => ({ subscribe: vi.fn() }))
vi.mock('./runtime-environments/runtime-environment-transport-routing', () => ({
  subscribeRuntimeEnvironment: transport.subscribe
}))
vi.mock('electron', async () => ({
  ...(await import('./notifications-test-harness')).createElectronModuleMock(),
  ipcMain: {
    handle: (await import('./notifications-test-harness')).handleMock,
    removeHandler: vi.fn(),
    on: vi.fn()
  }
}))
vi.mock('./notification-authorization-status', async () =>
  (await import('./notifications-test-harness')).createNotificationAuthorizationModuleMock()
)
vi.mock('./ui', async () =>
  (await import('./notifications-test-harness')).createTrustedUIRendererModuleMock()
)
vi.mock('../tray/system-tray', async () =>
  (await import('./notifications-test-harness')).createSystemTrayModuleMock()
)
let root: string
const pending = new Map<string, PendingRuntimeSubscription>()
const retained = new Map<string, RetainedRemoteRuntimeSubscription>()
const mobile = vi.fn()
const key = Buffer.alloc(32, 1)
const frame = (id: string): RuntimeRpcResponse<unknown> => ({
  id,
  ok: true,
  result: { type: 'completion' },
  _meta: { runtimeId: 'host' }
})
function handler(name: string) {
  const entry: unknown[] | undefined = handleMock.mock.calls.find(([channel]) => channel === name)
  const run = entry?.[1]
  if (typeof run !== 'function') {
    throw new Error(`Missing IPC ${name}`)
  }
  return run
}
const sender = Object.assign(new EventEmitter(), { id: 9, isDestroyed: () => false, send: vi.fn() })
function save(publicKey = key) {
  const environment = createEnvironmentFromPairingOffer({
    id: 'source',
    name: 'Source',
    now: 1,
    runtimeId: null,
    offer: {
      v: 2,
      endpoint: 'ws://127.0.0.1:6768',
      deviceToken: 'token',
      publicKeyB64: publicKey.toString('base64')
    }
  })
  writeFileSync(
    join(root, 'orca-environments.json'),
    JSON.stringify({ version: 1, environments: [environment] })
  )
  return environment
}
let sequence = 0
const request = (context?: RuntimeSubscriptionContext): NotificationDispatchRequest => ({
  source: 'agent-task-complete',
  notificationId: 'subject',
  executionHost: 'runtime:source',
  forwardingEnvironmentId: 'source',
  forwardingSource: context,
  structuredOrigin: {
    scope: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace',
      workspaceKind: 'folder'
    },
    sessionId: 'session',
    cause: { kind: 'completion', requestId: 'turn' },
    journalCursor: { epoch: 'journal', sequence: ++sequence }
  }
})
beforeEach(() => {
  resetNotificationDispatchMocks()
  mobile.mockClear()
  transport.subscribe.mockReset()
  sender.send.mockReset()
  root = mkdtempSync(join(tmpdir(), 'pr35901-source-'))
  save()
  vi.spyOn(app, 'getPath').mockReturnValue(root)
  registerRuntimeEnvironmentSubscriptionHandlers({
    getUserDataPath: () => root,
    pendingSubscriptions: pending,
    remoteRuntimeSubscriptions: retained,
    recordLayoutFrame: () => {}
  })
  registerNotificationHandlers(
    createNotificationStore({
      enabled: false,
      agentTaskComplete: true,
      terminalBell: true,
      mutedNotificationSourceIds: []
    }),
    createNotificationRuntime({
      dispatchMobileNotification: mobile,
      onForwardedNotificationEnvironmentsChanged: () => () => {}
    }),
    (id, environment, context) =>
      findForwardedPushSource(pending, retained, id, environment, context)
  )
})
afterEach(() => {
  for (const owner of pending.values()) {
    owner.close()
  }
  for (const owner of retained.values()) {
    owner.close()
  }
  pending.clear()
  retained.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  rmSync(root, { recursive: true, force: true })
})

it('stamps the authenticated first frame before promotion through preload, typed callback and notification IPC; stale edges stay legacy', async () => {
  const setup = Promise.withResolvers<RemoteRuntimeSubscription>()
  let callbacks: Parameters<typeof subscribeRuntimeEnvironment>[5] | undefined
  transport.subscribe.mockImplementation(
    (...parameters: Parameters<typeof subscribeRuntimeEnvironment>) => {
      callbacks = parameters[5]
      const environment = resolveEnvironment(root, 'source')
      callbacks.onSource?.(environment, getPreferredPairedRuntimeConnection(environment))
      return setup.promise
    }
  )
  let listener:
    | ((
        event: unknown,
        payload: { subscriptionId: string; type: 'response'; response: RuntimeRpcResponse<unknown> }
      ) => void)
    | undefined
  const ipc = {
    invoke: async (channel: string, args: unknown) => handler(channel)({ sender }, args),
    send: () => {},
    on: (_channel: string, next: NonNullable<typeof listener>) => {
      listener = next
    },
    removeListener: () => {
      listener = undefined
    }
  }
  sender.send.mockImplementation((_channel, payload) => listener?.({}, payload))
  vi.stubGlobal('window', {
    api: {
      runtimeEnvironments: {
        subscribe: (
          args: Parameters<typeof subscribeRuntimeEnvironmentFromPreload>[1],
          hooks: Parameters<typeof subscribeRuntimeEnvironmentFromPreload>[2]
        ) => subscribeRuntimeEnvironmentFromPreload(ipc, args, hooks, () => 'reused')
      }
    }
  })
  let captured: RuntimeSubscriptionContext | undefined
  const opened = subscribeRuntimeRpc(
    { kind: 'environment', environmentId: 'source' },
    'agentSession.subscribeTurnCompletions',
    {},
    {
      onEvent: (_edge, context) => {
        captured = context
        getDispatchHandler()({ sender }, request(context))
      },
      onClose: () => {},
      onError: () => {}
    }
  )
  const active = required(() => callbacks)
  const pendingSource = pending.get('reused')?.source
  active.onEvent({ type: 'response', response: frame('R1') })
  expect(captured).toEqual({ subscriptionId: 'reused', requestId: 'R1' })
  expect(mobile).toHaveBeenLastCalledWith(
    expect.objectContaining({ origin: deriveRelayHostId(key), occurrence: expect.any(String) })
  )
  setup.resolve({ requestId: 'R1', close: vi.fn(), sendBinary: () => true })
  const live = await opened
  expect(retained.get('reused')?.source).toBe(pendingSource)
  // Same source survives ordinary subsequent frames.
  active.onEvent({ type: 'response', response: frame('R1') })
  expect(mobile).toHaveBeenLastCalledWith(
    expect.objectContaining({ origin: deriveRelayHostId(key) })
  )
  const late = request(captured)
  live.unsubscribe()
  save(Buffer.alloc(32, 2))
  let successorCallbacks: Parameters<typeof subscribeRuntimeEnvironment>[5] | undefined
  transport.subscribe.mockImplementation(
    async (...parameters: Parameters<typeof subscribeRuntimeEnvironment>) => {
      successorCallbacks = parameters[5]
      const current = resolveEnvironment(root, 'source')
      successorCallbacks.onSource?.(current, getPreferredPairedRuntimeConnection(current))
      return { requestId: 'R2', close: vi.fn(), sendBinary: () => true }
    }
  )
  const successor = await subscribeRuntimeRpc(
    { kind: 'environment', environmentId: 'source' },
    'agentSession.subscribeTurnCompletions',
    {},
    {
      onEvent: (_edge, context) => getDispatchHandler()({ sender }, request(context)),
      onError: () => {},
      onClose: () => {}
    }
  )
  getDispatchHandler()({ sender }, late)
  expect(mobile.mock.lastCall?.[0]).not.toHaveProperty('origin')
  expect(mobile.mock.lastCall?.[0]).not.toHaveProperty('occurrence')
  const successorEvents = required(() => successorCallbacks)
  successorEvents.onEvent({ type: 'response', response: frame('R2') })
  expect(mobile).toHaveBeenLastCalledWith(
    expect.objectContaining({ origin: deriveRelayHostId(Buffer.alloc(32, 2)) })
  )
  // Current-file re-pair without a connection retirement cannot lend its key to the old owner.
  save(Buffer.alloc(32, 3))
  successorEvents.onEvent({ type: 'response', response: frame('R2') })
  expect(mobile.mock.lastCall?.[0]).not.toHaveProperty('origin')
  successor.unsubscribe()
})

it.each([
  'close',
  'reload',
  'cancel',
  'contradictory request',
  'contradictory returned ID',
  'wrong sender',
  'wrong environment',
  'missing context'
])('falls back promptly after %s during pending setup', async (kind) => {
  const setup = Promise.withResolvers<RemoteRuntimeSubscription>()
  let callbacks: Parameters<typeof subscribeRuntimeEnvironment>[5] | undefined
  transport.subscribe.mockImplementation(
    (...parameters: Parameters<typeof subscribeRuntimeEnvironment>) => {
      callbacks = parameters[5]
      const selected = resolveEnvironment(root, 'source')
      callbacks.onSource?.(selected, getPreferredPairedRuntimeConnection(selected))
      return setup.promise
    }
  )
  const opening = handler('runtimeEnvironments:subscribe')(
    { sender },
    {
      selector: 'source',
      method: 'agentSession.subscribeTurnCompletions',
      subscriptionId: 'pending'
    }
  )
  const active = required(() => callbacks)
  active.onEvent({ type: 'response', response: frame('R1') })
  const context = { subscriptionId: 'pending', requestId: 'R1' }
  if (kind === 'close') {
    active.onEvent({ type: 'close' })
    active.onClose()
  }
  if (kind === 'reload') {
    sender.emit('did-navigate')
  }
  if (kind === 'cancel') {
    handler('runtimeEnvironments:unsubscribe')({ sender }, { subscriptionId: 'pending' })
  }
  if (kind === 'contradictory request') {
    active.onEvent({ type: 'response', response: frame('R-other') })
  }
  if (kind === 'contradictory returned ID') {
    setup.resolve({ requestId: 'other', close: vi.fn(), sendBinary: () => true })
    await opening
  }
  const payload = request(kind === 'missing context' ? undefined : context)
  if (kind === 'wrong environment') {
    payload.forwardingEnvironmentId = 'other'
  }
  getDispatchHandler()({ sender: kind === 'wrong sender' ? { id: 10 } : sender }, payload)
  expect(mobile).toHaveBeenCalledTimes(1)
  expect(mobile.mock.lastCall?.[0]).not.toHaveProperty('origin')
  setup.resolve({ requestId: 'R1', close: vi.fn(), sendBinary: () => true })
  await opening
})
