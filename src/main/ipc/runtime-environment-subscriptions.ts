import { ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { resolveEnvironment } from '../../shared/runtime-environment-store'
import type { RemoteRuntimeSubscription } from '../../shared/remote-runtime-client'
import { isRuntimeEnvironmentManuallyDisconnected } from './runtime-environment-manual-disconnect'
import { getRuntimeEnvironmentTransportGeneration } from './runtime-environment-transport-generation'
import { subscribeRuntimeEnvironment } from './runtime-environment-transport-routing'

type RetainedRemoteRuntimeSubscription = RemoteRuntimeSubscription & {
  token: symbol
  environmentId: string
  method: string
  refreshTransportGeneration: () => void
  ownerWebContentsId: number
  removeDestroyedListener: () => void
  notifyClosed: () => void
}
const remoteRuntimeSubscriptions = new Map<string, RetainedRemoteRuntimeSubscription>()
const pendingSubscriptions = new Map<string, symbol>()

function isResourceStream(method: string): boolean {
  return (
    method === 'terminal.subscribe' ||
    method === 'terminal.multiplex' ||
    method === 'browser.screencast'
  )
}

export function closeSubscriptionsForEnvironment(
  environmentId: string,
  options?: { preserveResourceStreams: true }
): void {
  // Why: removed runtimes must not retain terminal/browser WebSockets until renderer teardown.
  for (const [subscriptionId, subscription] of remoteRuntimeSubscriptions) {
    if (subscription.environmentId !== environmentId) {
      continue
    }
    if (options?.preserveResourceStreams && isResourceStream(subscription.method)) {
      subscription.refreshTransportGeneration()
      continue
    }
    remoteRuntimeSubscriptions.delete(subscriptionId)
    // Why: one failing teardown must not abandon this environment's other
    // sockets -- that strands exactly the dead handles this sweep exists to
    // retire. Guard the two steps independently so neither can skip the other,
    // and so the isolation stays structural rather than resting on a claim that
    // nothing inside notifyClosed will ever throw.
    try {
      subscription.close()
    } catch (error) {
      console.warn('[runtime-environments] subscription close failed during retirement:', error)
    }
    try {
      // Why: a shared-control logical close never calls back, so notify directly.
      subscription.notifyClosed()
    } catch (error) {
      console.warn('[runtime-environments] subscription close notice failed:', error)
    }
  }
}
export function registerRuntimeEnvironmentSubscriptions(getUserDataPath: () => string): void {
  ipcMain.handle(
    'runtimeEnvironments:subscribe',
    async (
      event,
      args: {
        selector: string
        method: string
        params?: unknown
        timeoutMs?: number
        subscriptionId?: string
        expectedEnvironmentPairingRevision?: number
      }
    ): Promise<{ subscriptionId: string; requestId: string }> => {
      const subscriptionId =
        typeof args.subscriptionId === 'string' && args.subscriptionId.length > 0
          ? args.subscriptionId
          : randomUUID()
      if (
        remoteRuntimeSubscriptions.has(subscriptionId) ||
        pendingSubscriptions.has(subscriptionId)
      ) {
        throw new Error('Runtime environment subscription id already exists')
      }
      const environment = resolveEnvironment(getUserDataPath(), args.selector)
      if (isRuntimeEnvironmentManuallyDisconnected(environment.id)) {
        throw new Error('runtime_manually_disconnected')
      }
      const pairingRevision = environment.pairingRevision ?? environment.createdAt
      if (
        args.expectedEnvironmentPairingRevision !== undefined &&
        pairingRevision !== args.expectedEnvironmentPairingRevision
      ) {
        throw new Error('Runtime environment pairing changed; refresh and try again')
      }
      const generationScope = isResourceStream(args.method) ? 'resource' : 'control'
      let transportGeneration = getRuntimeEnvironmentTransportGeneration(
        environment.id,
        generationScope
      )
      const token = Symbol(subscriptionId)
      let closed = false
      const ownsId = (): boolean =>
        pendingSubscriptions.get(subscriptionId) === token ||
        remoteRuntimeSubscriptions.get(subscriptionId)?.token === token
      const releasePending = (): void => {
        if (pendingSubscriptions.get(subscriptionId) === token) {
          pendingSubscriptions.delete(subscriptionId)
        }
      }
      const transportIsCurrent = (): boolean =>
        getRuntimeEnvironmentTransportGeneration(environment.id, generationScope) ===
        transportGeneration
      const sender = event.sender
      const ownerWebContentsId = sender.id
      let senderDestroyed = sender.isDestroyed()
      let subscription: RemoteRuntimeSubscription | null = null
      let destroyedListenerAttached = false
      const removeDestroyedListener = (): void => {
        if (!destroyedListenerAttached) {
          return
        }
        destroyedListenerAttached = false
        sender.removeListener('destroyed', closeSubscription)
      }
      const closeSubscription = (): void => {
        senderDestroyed = true
        closed = true
        releasePending()
        const retained = remoteRuntimeSubscriptions.get(subscriptionId) ?? null
        if (retained?.token === token) {
          remoteRuntimeSubscriptions.delete(subscriptionId)
          retained.close()
          return
        }
        removeDestroyedListener()
        subscription?.close()
      }
      // Why: the renderer treats close as terminal and drops its handle, so send it once.
      // Latch before sending so a re-entrant call cannot duplicate it, and never
      // throw: a dying renderer must not abort its siblings' retirement.
      let closeNotified = false
      const notifyClosed = (): void => {
        closed = true
        if (closeNotified || sender.isDestroyed()) {
          return
        }
        closeNotified = true
        try {
          sender.send('runtimeEnvironments:subscriptionEvent', { subscriptionId, type: 'close' })
        } catch {
          // The renderer is gone; there is no one left to tell.
        }
      }
      pendingSubscriptions.set(subscriptionId, token)
      try {
        sender.once('destroyed', closeSubscription)
        destroyedListenerAttached = true
        subscription = await subscribeRuntimeEnvironment(
          getUserDataPath(),
          environment.id,
          args.method,
          args.params,
          args.timeoutMs,
          {
            onEvent: (payload) => {
              if (payload.type === 'close') {
                // Why: retirement advances the generation before closing, so gating
                // close on it stranded the renderer with a dead subscription.
                if (ownsId()) {
                  notifyClosed()
                }
                return
              }
              if (!closed && ownsId() && transportIsCurrent() && !sender.isDestroyed()) {
                sender.send('runtimeEnvironments:subscriptionEvent', {
                  subscriptionId,
                  ...payload
                })
              }
            },
            onClose: () => {
              closed = true
              releasePending()
              removeDestroyedListener()
              const retained = remoteRuntimeSubscriptions.get(subscriptionId) ?? null
              if (retained?.token === token) {
                remoteRuntimeSubscriptions.delete(subscriptionId)
              }
            }
          },
          () => !closed && ownsId() && transportIsCurrent()
        )
      } catch (error) {
        closed = true
        releasePending()
        removeDestroyedListener()
        throw error
      }
      releasePending()
      let pairingIsCurrent = false
      try {
        const currentEnvironment = resolveEnvironment(getUserDataPath(), environment.id)
        pairingIsCurrent =
          (currentEnvironment.pairingRevision ?? currentEnvironment.createdAt) === pairingRevision
      } catch {
        pairingIsCurrent = false
      }
      if (!transportIsCurrent() || !pairingIsCurrent) {
        removeDestroyedListener()
        subscription.close()
        throw new Error('Runtime environment pairing changed; refresh and try again')
      }
      if (senderDestroyed || sender.isDestroyed()) {
        removeDestroyedListener()
        subscription.close()
        return { subscriptionId, requestId: subscription.requestId }
      }
      if (closed) {
        removeDestroyedListener()
        subscription.close()
        throw new Error('Runtime environment subscription closed during setup')
      }
      remoteRuntimeSubscriptions.set(subscriptionId, {
        token,
        method: args.method,
        refreshTransportGeneration: () => {
          transportGeneration = getRuntimeEnvironmentTransportGeneration(
            environment.id,
            generationScope
          )
        },
        requestId: subscription.requestId,
        environmentId: environment.id,
        ownerWebContentsId,
        removeDestroyedListener,
        notifyClosed,
        sendBinary: (bytes) => subscription?.sendBinary(bytes) ?? false,
        close: () => {
          closed = true
          removeDestroyedListener()
          subscription?.close()
        }
      })
      return { subscriptionId, requestId: subscription.requestId }
    }
  )
  ipcMain.handle(
    'runtimeEnvironments:unsubscribe',
    (event, args: { subscriptionId: string }): { unsubscribed: boolean } => {
      const subscription = remoteRuntimeSubscriptions.get(args.subscriptionId)
      if (!subscription || subscription.ownerWebContentsId !== event.sender.id) {
        return { unsubscribed: false }
      }
      remoteRuntimeSubscriptions.delete(args.subscriptionId)
      subscription.close()
      return { unsubscribed: true }
    }
  )
  ipcMain.on(
    'runtimeEnvironments:subscriptionBinary',
    (event, args: { subscriptionId?: unknown; bytes?: unknown }) => {
      if (typeof args.subscriptionId !== 'string') {
        return
      }
      const bytes = toBinaryPayload(args.bytes)
      if (!bytes) {
        return
      }
      const subscription = remoteRuntimeSubscriptions.get(args.subscriptionId)
      if (subscription?.ownerWebContentsId === event.sender.id) {
        subscription.sendBinary(bytes)
      }
    }
  )
}

function toBinaryPayload(value: unknown): Uint8Array<ArrayBufferLike> | null {
  if (value instanceof Uint8Array) {
    return value
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value)
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  }
  return null
}
