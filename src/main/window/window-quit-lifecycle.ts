type WindowQuitLifecycleOptions = {
  fenceTransfers: () => Promise<void>
  freezeSessions: () => void
  resumeTransfers: () => void
  resumeSessions: () => void
}

type WindowQuitPersistenceStep =
  | 'transfer-fence'
  | 'stage-sessions'
  | 'ssh-shutdown'
  | 'kill-pty'
  | 'store-flush'

type WindowQuitPersistenceOptions = {
  transferFence: Promise<void>
  stageSessions: () => void
  beginSshShutdown: () => Promise<unknown>
  killAllPty: () => void
  flushStore: () => Promise<void>
  onError: (step: WindowQuitPersistenceStep, error: unknown) => void
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
  const recordFailure = (step: WindowQuitPersistenceStep, error: unknown): void => {
    errors.push(error)
    options.onError(step, error)
  }
  const [transferResult] = await Promise.allSettled([options.transferFence])
  if (transferResult.status === 'rejected') {
    recordFailure('transfer-fence', transferResult.reason)
  }
  try {
    options.stageSessions()
  } catch (error) {
    recordFailure('stage-sessions', error)
  }
  let sshShutdown: Promise<unknown> = Promise.resolve()
  try {
    sshShutdown = options.beginSshShutdown().catch((error: unknown) => {
      recordFailure('ssh-shutdown', error)
    })
  } catch (error) {
    recordFailure('ssh-shutdown', error)
  }
  try {
    options.killAllPty()
  } catch (error) {
    recordFailure('kill-pty', error)
  }
  let storeFlush: Promise<unknown> = Promise.resolve()
  try {
    storeFlush = options.flushStore().catch((error: unknown) => {
      recordFailure('store-flush', error)
    })
  } catch (error) {
    recordFailure('store-flush', error)
  }
  await Promise.allSettled([sshShutdown, storeFlush])
  if (errors.length > 0) {
    throw errors[0]
  }
}
