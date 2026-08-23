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
  await Promise.allSettled([options.transferFence])
  let stageError: unknown
  try {
    options.stageSessions()
  } catch (error) {
    stageError = error
  }
  const sshShutdown = options.beginSshShutdown()
  options.killAllPty()
  const storeFlush = options.flushStore()
  await Promise.allSettled([sshShutdown, storeFlush])
  if (stageError) {
    throw stageError
  }
}
