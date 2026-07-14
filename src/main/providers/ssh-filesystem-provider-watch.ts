import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import type { FsChangeEvent } from '../../shared/types'

export type WatchRegistration = {
  callbacks: Set<(events: FsChangeEvent[]) => void>
  setupPromise: Promise<void>
  setupAbortController: AbortController
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
  setupPromise: Promise<void>,
  signal?: AbortSignal
): Promise<void> {
  if (!signal) {
    await setupPromise
    return
  }
  if (signal.aborted) {
    throw createWatchAbortError()
  }
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      cleanup()
      reject(createWatchAbortError())
    }
    const onSettled = (error?: unknown): void => {
      cleanup()
      if (error === undefined) {
        resolve()
      } else {
        reject(error)
      }
    }
    const cleanup = (): void => {
      signal.removeEventListener('abort', onAbort)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    setupPromise.then(
      () => onSettled(),
      (error) => onSettled(error)
    )
  })
}

export async function registerSshFilesystemWatch(args: {
  mux: SshChannelMultiplexer
  disposed: () => boolean
  registrations: Map<string, WatchRegistration>
  rootPath: string
  callback: (events: FsChangeEvent[]) => void
  signal?: AbortSignal
}): Promise<() => void> {
  if (args.disposed()) {
    throw new Error('SSH filesystem provider disposed')
  }
  if (args.signal?.aborted) {
    throw createWatchAbortError()
  }

  let registration = args.registrations.get(args.rootPath)
  if (registration) {
    if (registration.stopping) {
      throw createWatchAbortError()
    }
    registration.callbacks.add(args.callback)
    try {
      // Why: each caller may leave a shared setup independently; registration
      // ownership decides whether the physical relay request should stop.
      await awaitSetupWithOptionalAbort(registration.setupPromise, args.signal)
      assertActiveWatch(args, registration)
      return createSshFilesystemWatchUnsubscribe(args, registration)
    } catch (error) {
      releaseSshFilesystemWatchCallback(args, registration)
      throw error
    }
  }

  const callbacks = new Set<(events: FsChangeEvent[]) => void>([args.callback])
  const setupAbortController = new AbortController()
  registration = {
    callbacks,
    setupAbortController,
    ready: false,
    stopping: false,
    unwatchSent: false,
    setupPromise: Promise.resolve()
  }
  const createdRegistration = registration
  // Why: the shared registration, not its first caller, owns relay setup.
  // This keeps a same-root joiner alive when the original caller disconnects.
  registration.setupPromise = args.mux
    .request('fs.watch', { rootPath: args.rootPath }, { signal: setupAbortController.signal })
    .then(
      () => {
        createdRegistration.ready = true
        if (
          createdRegistration.stopping ||
          createdRegistration.callbacks.size === 0 ||
          args.disposed() ||
          args.registrations.get(args.rootPath) !== createdRegistration
        ) {
          if (args.registrations.get(args.rootPath) === createdRegistration) {
            args.registrations.delete(args.rootPath)
          }
          sendSshFilesystemUnwatchOnce(args.mux, args.rootPath, createdRegistration)
        }
      },
      (error) => {
        if (args.registrations.get(args.rootPath) === createdRegistration) {
          args.registrations.delete(args.rootPath)
        }
        throw error
      }
    )
  args.registrations.set(args.rootPath, registration)
  try {
    await awaitSetupWithOptionalAbort(registration.setupPromise, args.signal)
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

function assertActiveWatch(
  args: {
    disposed: () => boolean
    registrations: Map<string, WatchRegistration>
    rootPath: string
  },
  registration: WatchRegistration
): void {
  if (args.disposed() || args.registrations.get(args.rootPath) !== registration) {
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
  if (registration.callbacks.size > 0 || args.registrations.get(args.rootPath) !== registration) {
    return
  }
  registration.stopping = true
  if (registration.ready) {
    args.registrations.delete(args.rootPath)
    sendSshFilesystemUnwatchOnce(args.mux, args.rootPath, registration)
  } else {
    // Keep the cancelling registration indexed until its request settles so a
    // new same-root setup cannot race an old late success and be unwatched.
    registration.setupAbortController.abort()
  }
}

export function stopSshFilesystemWatchRegistration(
  mux: SshChannelMultiplexer,
  rootPath: string,
  registration: WatchRegistration
): void {
  registration.stopping = true
  registration.setupAbortController.abort()
  sendSshFilesystemUnwatchOnce(mux, rootPath, registration)
}

function sendSshFilesystemUnwatchOnce(
  mux: SshChannelMultiplexer,
  rootPath: string,
  registration: WatchRegistration
): void {
  if (registration.unwatchSent) {
    return
  }
  registration.unwatchSent = true
  notifySshFilesystemUnwatch(mux, rootPath)
}
