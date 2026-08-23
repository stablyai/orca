type WindowQuitLifecycleOptions = {
  fenceTransfers: () => Promise<void>
  freezeSessions: () => void
  resumeTransfers: () => void
  resumeSessions: () => void
}

type WindowQuitPersistenceOptions = {
  transferFence: Promise<void>
  stageSessions: () => void
  beginSshShutdown: () => Promise<unknown>
  killAllPty: () => void
  flushStore: () => Promise<void>
}

export function createWindowQuitLifecycle(options: WindowQuitLifecycleOptions): {
  begin: () => Promise<void>
  abort: () => void
  isActive: () => boolean
} {
  let pending: Promise<void> | null = null
  return {
    begin: () => {
      if (!pending) {
        pending = options.fenceTransfers()
        options.freezeSessions()
      }
      return pending
    },
    abort: () => {
      if (!pending) {
        return
      }
      pending = null
      options.resumeTransfers()
      options.resumeSessions()
    },
    isActive: () => pending !== null
  }
}

export async function finishWindowSessionPersistenceForQuit(
  options: WindowQuitPersistenceOptions
): Promise<void> {
  const errors: unknown[] = []
  const [transferResult] = await Promise.allSettled([options.transferFence])
  if (transferResult.status === 'rejected') {
    errors.push(transferResult.reason)
  }
  try {
    options.stageSessions()
  } catch (error) {
    errors.push(error)
  }
  let sshShutdown: Promise<unknown> = Promise.resolve()
  try {
    sshShutdown = options.beginSshShutdown()
  } catch (error) {
    errors.push(error)
  }
  try {
    options.killAllPty()
  } catch (error) {
    errors.push(error)
  }
  let storeFlush: Promise<unknown> = Promise.resolve()
  try {
    storeFlush = options.flushStore()
  } catch (error) {
    errors.push(error)
  }
  for (const result of await Promise.allSettled([sshShutdown, storeFlush])) {
    if (result.status === 'rejected') {
      errors.push(result.reason)
    }
  }
  if (errors.length > 0) {
    throw errors[0]
  }
}
