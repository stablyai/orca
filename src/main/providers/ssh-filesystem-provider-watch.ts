import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import type { FsChangeEvent } from '../../shared/types'
import { isMethodNotFoundError } from '../ssh/ssh-filesystem-stream-reader'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { PromiseSettlementWaiters } from '../../shared/promise-settlement-waiters'

let nextRemoteWatchId = 1

export type WatchRegistration = {
  rootPath: string
  callbacks: Set<(events: FsChangeEvent[]) => void>
  terminalCallbacks: Map<(events: FsChangeEvent[]) => void, (error: Error) => void>
  setupWaiters: PromiseSettlementWaiters<void>
  setupAbortController: AbortController
  remoteWatchId: number | null
  ready: boolean
  stopping: boolean
  unwatchSent: boolean
}

function createWatchAbortError(): Error {
  const error = new Error('Request "fs.watch" was cancelled') as Error & { name: string }
  error.name = 'AbortError'
  return error
}

async function awaitSetupWithOptionalAbort(
  setupWaiters: PromiseSettlementWaiters<void>,
  signal?: AbortSignal
): Promise<void> {
  await setupWaiters.wait({
    signal,
    createAbortError: createWatchAbortError
  })
}

export async function registerSshFilesystemWatch(args: {
  mux: SshChannelMultiplexer
  disposed: () => boolean
  registrations: Map<string, WatchRegistration>
  rootPath: string
  callback: (events: FsChangeEvent[]) => void
  onTerminalError?: (error: Error) => void
  signal?: AbortSignal
}): Promise<() => void> {
  if (args.disposed()) {
    throw new Error('SSH filesystem provider disposed')
  }
  if (args.signal?.aborted) {
    throw createWatchAbortError()
  }

  const rootKey = sshFilesystemWatchKey(args.rootPath)
  let registration = args.registrations.get(rootKey)
  if (registration) {
    if (registration.stopping) {
      throw createWatchAbortError()
    }
    registration.callbacks.add(args.callback)
    registration.terminalCallbacks.set(args.callback, args.onTerminalError ?? (() => undefined))
    try {
      // Why: each caller may leave a shared setup independently; registration
      // ownership decides whether the physical relay request should stop.
      await awaitSetupWithOptionalAbort(registration.setupWaiters, args.signal)
      assertActiveWatch(args, registration)
      return createSshFilesystemWatchUnsubscribe(args, registration)
    } catch (error) {
      releaseSshFilesystemWatchCallback(args, registration)
      throw error
    }
  }

  const callbacks = new Set<(events: FsChangeEvent[]) => void>([args.callback])
  const setupAbortController = new AbortController()
  const remoteWatchId = nextRemoteWatchId++
  if (!Number.isSafeInteger(nextRemoteWatchId)) {
    nextRemoteWatchId = 1
  }
  registration = {
    rootPath: args.rootPath,
    callbacks,
    terminalCallbacks: new Map([[args.callback, args.onTerminalError ?? (() => undefined)]]),
    setupAbortController,
    remoteWatchId,
    ready: false,
    stopping: false,
    unwatchSent: false,
    setupWaiters: new PromiseSettlementWaiters(Promise.resolve())
  }
  const createdRegistration = registration
  // Why: the shared registration, not its first caller, owns relay setup.
  // This keeps a same-root joiner alive when the original caller disconnects.
  const setupPromise = args.mux
    .request(
      'fs.watch',
      { rootPath: args.rootPath, watchId: remoteWatchId },
      { signal: setupAbortController.signal }
    )
    .then(
      () => {
        createdRegistration.ready = true
        if (
          createdRegistration.stopping ||
          createdRegistration.callbacks.size === 0 ||
          args.disposed() ||
          args.registrations.get(rootKey) !== createdRegistration
        ) {
          if (args.registrations.get(rootKey) === createdRegistration) {
            args.registrations.delete(rootKey)
          }
          sendSshFilesystemUnwatchOnce(args.mux, createdRegistration)
        }
      },
      (error) => {
        if (args.registrations.get(rootKey) === createdRegistration) {
          args.registrations.delete(rootKey)
        }
        throw error
      }
    )
  registration.setupWaiters = new PromiseSettlementWaiters(setupPromise)
  args.registrations.set(rootKey, registration)
  try {
    await awaitSetupWithOptionalAbort(registration.setupWaiters, args.signal)
    assertActiveWatch(args, registration)
    return createSshFilesystemWatchUnsubscribe(args, registration)
  } catch (error) {
    releaseSshFilesystemWatchCallback(args, registration)
    throw error
  }
}

export function notifySshFilesystemUnwatch(mux: SshChannelMultiplexer, rootPath: string): void {
  try {
    mux.notify('fs.unwatch', { rootPath })
  } catch {}
}

export async function closeSshFilesystemWatch(
  mux: SshChannelMultiplexer,
  registrations: Map<string, WatchRegistration>,
  rootPath: string
): Promise<void> {
  const rootKey = sshFilesystemWatchKey(rootPath)
  try {
    await mux.request('fs.unwatchAndWait', { rootPath })
  } catch (error) {
    if (!isMethodNotFoundError(error)) {
      throw error
    }
    throw new Error('Remote watcher teardown is unavailable. Reconnect the SSH target and retry.')
  }
  registrations.get(rootKey)?.callbacks.clear()
  registrations.get(rootKey)?.terminalCallbacks.clear()
  registrations.delete(rootKey)
}

export function failSshFilesystemWatchRegistration(
  registrations: Map<string, WatchRegistration>,
  rootPath: string,
  remoteWatchId: number,
  error: Error
): void {
  const rootKey = sshFilesystemWatchKey(rootPath)
  const registration = registrations.get(rootKey)
  if (!registration || registration.remoteWatchId !== remoteWatchId) {
    return
  }
  registrations.delete(rootKey)
  registration.stopping = true
  registration.unwatchSent = true
  const terminalCallbacks = Array.from(registration.terminalCallbacks.values())
  registration.callbacks.clear()
  registration.terminalCallbacks.clear()
  for (const onTerminalError of terminalCallbacks) {
    try {
      onTerminalError(error)
    } catch (callbackError) {
      console.error('[ssh-fs] terminal watch callback failed', callbackError)
    }
  }
}

function assertActiveWatch(
  args: {
    disposed: () => boolean
    registrations: Map<string, WatchRegistration>
    rootPath: string
  },
  registration: WatchRegistration
): void {
  if (
    args.disposed() ||
    args.registrations.get(sshFilesystemWatchKey(args.rootPath)) !== registration
  ) {
    throw new Error('SSH filesystem provider disposed')
  }
}

function createSshFilesystemWatchUnsubscribe(
  args: {
    mux: SshChannelMultiplexer
    registrations: Map<string, WatchRegistration>
    rootPath: string
    callback: (events: FsChangeEvent[]) => void
  },
  registration: WatchRegistration
): () => void {
  return () => {
    releaseSshFilesystemWatchCallback(args, registration)
  }
}

function releaseSshFilesystemWatchCallback(
  args: {
    mux: SshChannelMultiplexer
    registrations: Map<string, WatchRegistration>
    rootPath: string
    callback: (events: FsChangeEvent[]) => void
  },
  registration: WatchRegistration
): void {
  registration.callbacks.delete(args.callback)
  registration.terminalCallbacks.delete(args.callback)
  const rootKey = sshFilesystemWatchKey(args.rootPath)
  if (registration.callbacks.size > 0 || args.registrations.get(rootKey) !== registration) {
    return
  }
  registration.stopping = true
  if (registration.ready) {
    args.registrations.delete(rootKey)
    sendSshFilesystemUnwatchOnce(args.mux, registration)
  } else {
    // Keep the cancelling registration indexed until its request settles so a
    // new same-root setup cannot race an old late success and be unwatched.
    registration.setupAbortController.abort()
  }
}

export function stopSshFilesystemWatchRegistration(
  mux: SshChannelMultiplexer,
  registration: WatchRegistration
): void {
  registration.stopping = true
  registration.setupAbortController.abort()
  sendSshFilesystemUnwatchOnce(mux, registration)
}

function sendSshFilesystemUnwatchOnce(
  mux: SshChannelMultiplexer,
  registration: WatchRegistration
): void {
  if (registration.unwatchSent) {
    return
  }
  registration.unwatchSent = true
  notifySshFilesystemUnwatch(mux, registration.rootPath)
}

function sshFilesystemWatchKey(rootPath: string): string {
  return normalizeRuntimePathForComparison(rootPath)
}
