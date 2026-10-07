import { setRuntimeBrowserCommandsFactory } from '../runtime/runtime-browser-commands-factory'
import { startOrcadBrowserProvider } from './orcad-browser-startup'
import { OrcadRuntimeLifetime, type OrcadRuntimeCleanup } from './orcad-runtime-lifetime'
import type { OrcadManagedStopInstance } from '../../shared/orcad-stop-request'
import { acquireOrcadInstanceLock } from './orcad-instance-lock'
import { ORCAD_BUNDLED_LAUNCHER_ENV } from './orcad-bundled-runtime'
import { resolveOrcadExitCode } from './orcad-exit-code'
import { ORCAD_SHUTDOWN_DEADLINE_MS } from './orcad-stop-deadlines'
import {
  acquireProfileStateRuntimeAdmission,
  type ProfileStateRuntimeAdmission
} from '../persistence/profile-state/profile-state-access'

const bundledLauncherChannel = process.env[ORCAD_BUNDLED_LAUNCHER_ENV] === '1'
delete process.env[ORCAD_BUNDLED_LAUNCHER_ENV]

function createIdempotentOrcadCleanup(cleanup: () => Promise<void>): () => Promise<void> {
  let completion: Promise<void> | null = null
  return () => {
    completion ??= Promise.resolve().then(cleanup)
    return completion
  }
}

export { ORCAD_SHUTDOWN_DEADLINE_MS }

/** True when this call began the stop; false when another source already owns it. */
export type OrcadShutdownTrigger = (reason: string, onFailed?: () => void) => boolean

/**
 * A launcher and its child can both receive the same process-group or service stop signal.
 * Returns the trigger stop-request listeners share, so every source runs one bounded stop.
 * `onFailed` runs before a failed or overdue stop exits, so a caller can retract a clean record.
 */
export function installOrcadShutdownSignals(
  stop: () => Promise<void>,
  deadlineMs = ORCAD_SHUTDOWN_DEADLINE_MS
): OrcadShutdownTrigger {
  let stopping = false
  const shutdown: OrcadShutdownTrigger = (signal, onFailed) => {
    if (stopping) {
      return false
    }
    stopping = true
    setTimeout(() => {
      console.error(`orcad: shutdown after ${signal} exceeded ${deadlineMs}ms — exiting`)
      onFailed?.()
      process.exit(1)
    }, deadlineMs)
    stop()
      .then(() => process.exit(0))
      .catch((error) => {
        console.error(`orcad: shutdown after ${signal} failed:`, error)
        onFailed?.()
        process.exit(resolveOrcadExitCode(error))
      })
    return true
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  // Headless runtimes survive terminal hangups; INT/TERM are the graceful stop contract.
  if (process.platform !== 'win32') {
    process.on('SIGHUP', () => {})
  }
  if (bundledLauncherChannel && typeof process.send === 'function') {
    process.once('disconnect', () => shutdown('launcher disconnect'))
    if (!process.connected) {
      shutdown('launcher disconnect')
    }
  }
  return shutdown
}

export async function startOrcadWithLifecycle<T extends object>(
  start: (registerRuntimeCleanup: (cleanup: OrcadRuntimeCleanup) => void) => Promise<T>,
  cleanupHost: (runtimeCleanupSucceeded: boolean) => Promise<void>
): Promise<T & { stop(): Promise<void> }> {
  // Runtime resources stop in reverse registration order before any host resource.
  const runtime = new OrcadRuntimeLifetime()
  const cleanup = createIdempotentOrcadCleanup(async () => {
    let runtimeCleanupSucceeded = false
    try {
      await runtime.stop()
      runtimeCleanupSucceeded = true
    } finally {
      await cleanupHost(runtimeCleanupSucceeded)
    }
  })
  try {
    const handle = await start((nextCleanup) => runtime.add(nextCleanup))
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

/** Keep profile admission and the instance lock until every runtime writer has stopped. */
export async function startOrcadWithHost<T extends object>(
  userDataPath: string,
  start: (registerCleanup: (cleanup: OrcadRuntimeCleanup) => void) => Promise<T>,
  runQuitHandlers: () => void
): Promise<T & { stop(): Promise<void>; instance: OrcadManagedStopInstance }> {
  const instanceLock = acquireOrcadInstanceLock(userDataPath)
  const { pid, startedAtMs, nonce } = instanceLock.record
  const instance = { pid, startedAtMs, nonce, lockPath: instanceLock.path }
  let admission: ProfileStateRuntimeAdmission | undefined
  let browserProvider: ReturnType<typeof startOrcadBrowserProvider> | undefined
  return startOrcadWithLifecycle(
    async (registerCleanup) => {
      admission = acquireProfileStateRuntimeAdmission(userDataPath)
      // Why not awaited: a desktop sidecar's authorization UI must not hold RPC readiness hostage.
      browserProvider = startOrcadBrowserProvider({ userDataPath })
      return { ...(await start(registerCleanup)), instance }
    },
    async (runtimeCleanupSucceeded) => {
      // Failed teardown keeps both fences until the process actually exits.
      const host = new OrcadRuntimeLifetime(() => {
        if (runtimeCleanupSucceeded) {
          instanceLock.release()
        }
      })
      host.add(({ failed }) => {
        if (runtimeCleanupSucceeded && !failed) {
          admission?.release()
        }
      })
      host.add(() => runQuitHandlers())
      host.add(() => setRuntimeBrowserCommandsFactory(null))
      host.add(() => browserProvider?.stop())
      await host.stop()
    }
  )
}

export async function flushOrcadProfileStoreForShutdown(store: {
  flushFinalOrThrowAsync(): Promise<void>
  freezeWritesAsync(): Promise<void>
}): Promise<void> {
  try {
    await store.flushFinalOrThrowAsync()
  } finally {
    await store.freezeWritesAsync()
  }
}
