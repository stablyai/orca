import { setRuntimeBrowserCommandsFactory } from '../runtime/runtime-browser-commands-factory'
import { resolveOrcadBrowserProvider } from './orcad-browser-provider'
import { acquireOrcadInstanceLock } from './orcad-instance-lock'
import {
  acquireProfileStateRuntimeAdmission,
  type ProfileStateRuntimeAdmission
} from '../persistence/profile-state/profile-state-access'

function createIdempotentOrcadCleanup(cleanup: () => Promise<void>): () => Promise<void> {
  let completion: Promise<void> | null = null
  return () => {
    completion ??= Promise.resolve().then(cleanup)
    return completion
  }
}

export const ORCAD_SHUTDOWN_DEADLINE_MS = 15_000

/** A launcher and its child can both receive the same process-group or service stop signal. */
export function installOrcadShutdownSignals(stop: () => Promise<void>): void {
  let stopping = false
  const shutdown = (signal: NodeJS.Signals): void => {
    if (stopping) {
      return
    }
    stopping = true
    const deadline = setTimeout(() => {
      console.error(
        `orcad: shutdown after ${signal} exceeded ${ORCAD_SHUTDOWN_DEADLINE_MS}ms — exiting`
      )
      process.exit(1)
    }, ORCAD_SHUTDOWN_DEADLINE_MS)
    deadline.unref()
    stop()
      .then(() => process.exit(0))
      .catch((error) => {
        console.error(`orcad: shutdown after ${signal} failed:`, error)
        process.exit(1)
      })
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGHUP', () => shutdown('SIGHUP'))
}

export async function startOrcadWithLifecycle<T extends object>(
  start: (registerRuntimeCleanup: (cleanup: () => Promise<void>) => void) => Promise<T>,
  cleanupHost: (runtimeCleanupSucceeded: boolean) => Promise<void>
): Promise<T & { stop(): Promise<void> }> {
  let cleanupRuntime = async (): Promise<void> => {}
  const cleanup = createIdempotentOrcadCleanup(async () => {
    let runtimeCleanupSucceeded = false
    try {
      await cleanupRuntime()
      runtimeCleanupSucceeded = true
    } finally {
      await cleanupHost(runtimeCleanupSucceeded)
    }
  })
  try {
    const handle = await start((nextCleanup) => {
      cleanupRuntime = nextCleanup
    })
    return { ...handle, stop: cleanup }
  } catch (error) {
    try {
      await cleanup()
    } catch (cleanupError) {
      // Keep the launch failure as the supervisor-facing verdict; cleanup still needs a breadcrumb.
      console.error('[orcad] startup cleanup failed:', cleanupError)
    }
    throw error
  }
}

/** Keep profile admission until every runtime writer has stopped. */
export async function startOrcadWithHost<T extends object>(
  userDataPath: string,
  start: (registerCleanup: (cleanup: () => Promise<void>) => void) => Promise<T>,
  runQuitHandlers: () => void
): Promise<T & { stop(): Promise<void> }> {
  const instanceLock = acquireOrcadInstanceLock(userDataPath)
  let admission: ProfileStateRuntimeAdmission | undefined
  let browserProvider: Awaited<ReturnType<typeof resolveOrcadBrowserProvider>> | undefined
  return startOrcadWithLifecycle(
    async (registerCleanup) => {
      admission = acquireProfileStateRuntimeAdmission(userDataPath)
      browserProvider = await resolveOrcadBrowserProvider({ userDataPath })
      const provider = browserProvider
      setRuntimeBrowserCommandsFactory(provider?.factory ?? null, {
        headless: provider !== null,
        ...(provider ? { isAvailable: () => provider.isAvailable() } : {})
      })
      return start(registerCleanup)
    },
    async (runtimeCleanupSucceeded) => {
      try {
        await browserProvider?.stop()
      } finally {
        setRuntimeBrowserCommandsFactory(null)
        runQuitHandlers()
        try {
          // Failed teardown excludes recovery until the process actually exits.
          if (runtimeCleanupSucceeded) {
            admission?.release()
          }
        } finally {
          instanceLock.release()
        }
      }
    }
  )
}

export async function flushOrcadProfileStoreForShutdown(store: {
  flushFinalOrThrowAsync(options?: { exportJsonCompatibility?: boolean }): Promise<void>
  freezeWritesAsync(): Promise<void>
}): Promise<void> {
  try {
    await store.flushFinalOrThrowAsync({ exportJsonCompatibility: true })
  } finally {
    await store.freezeWritesAsync()
  }
}
