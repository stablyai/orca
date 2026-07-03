import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import type { FsChangeEvent } from '../../shared/types'

export type WatchRegistration = {
  callbacks: Set<(events: FsChangeEvent[]) => void>
  setupPromise: Promise<void>
}

export async function registerSshFilesystemWatch(args: {
  mux: SshChannelMultiplexer
  disposed: () => boolean
  registrations: Map<string, WatchRegistration>
  rootPath: string
  callback: (events: FsChangeEvent[]) => void
}): Promise<() => void> {
  if (args.disposed()) {
    throw new Error('SSH filesystem provider disposed')
  }
  let registration = args.registrations.get(args.rootPath)
  if (registration) {
    registration.callbacks.add(args.callback)
    await registration.setupPromise
    assertActiveWatch(args, registration)
    return createSshFilesystemWatchUnsubscribe(args, registration)
  }

  const callbacks = new Set<(events: FsChangeEvent[]) => void>([args.callback])
  const setupPromise = args.mux.request('fs.watch', { rootPath: args.rootPath }).then(
    () => undefined,
    (error) => {
      if (args.registrations.get(args.rootPath) === registration) {
        args.registrations.delete(args.rootPath)
      }
      throw error
    }
  )
  registration = { callbacks, setupPromise }
  args.registrations.set(args.rootPath, registration)
  await setupPromise
  if (args.disposed() || args.registrations.get(args.rootPath) !== registration) {
    notifySshFilesystemUnwatch(args.mux, args.rootPath)
    throw new Error('SSH filesystem provider disposed')
  }

  return createSshFilesystemWatchUnsubscribe(args, registration)
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
    registration.callbacks.delete(args.callback)
    if (
      registration.callbacks.size === 0 &&
      args.registrations.get(args.rootPath) === registration
    ) {
      args.registrations.delete(args.rootPath)
      notifySshFilesystemUnwatch(args.mux, args.rootPath)
    }
  }
}
