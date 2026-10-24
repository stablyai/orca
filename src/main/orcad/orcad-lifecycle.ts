import { setRuntimeBrowserCommandsFactory } from '../runtime/runtime-browser-commands-factory'
import { setDesktopBrowserBridgeHostEnabled } from '../runtime/desktop-browser-bridge/desktop-browser-bridge-registry'
import { ORCAD_MANAGED_ACTIVATION_ROOT_ENV } from '../../shared/orcad-managed-launch-env'
import { startOrcadBrowserProvider } from './orcad-browser-startup'
import { OrcadRuntimeLifetime, type OrcadRuntimeCleanup } from './orcad-runtime-lifetime'
import type { OrcadManagedStopInstance } from '../../shared/orcad-stop-request'
import { acquireOrcadInstanceLock } from './orcad-instance-lock'
import { ORCAD_BUNDLED_LAUNCHER_ENV } from './orcad-bundled-runtime'
import { resolveOrcadExitCode } from './orcad-exit-code'
import { recordAgentSessionRuntimeEnd } from '../runtime/agent-session-runtime-end-record'
import { ORCAD_SHUTDOWN_DEADLINE_MS } from './orcad-stop-deadlines'
import { holdOrcadTerminalAdmissionUntilExit } from './orcad-stop-terminal-admission'
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

/** Return whether this caller owns the stop; fatal faults supply a nonzero completed-stop code. */
export type OrcadShutdownTrigger = (
  reason: string,
  onFailed?: () => void,
  stoppedExitCode?: number
) => boolean

/** Deduplicate launcher/child signals into one bounded stop; onFailed retracts clean-stop records. */
export function installOrcadShutdownSignals(
  stop: () => Promise<void>,
  deadlineMs = ORCAD_SHUTDOWN_DEADLINE_MS
): OrcadShutdownTrigger {
  let stopping = false
  let exitCode = 0
  let failed = false
  let retractClean: (() => void) | undefined
  const markFailed = (): void => {
    if (!failed) {
      failed = true
      retractClean?.()
    }
  }
  const shutdown: OrcadShutdownTrigger = (signal, onFailed, stoppedExitCode = 0) => {
    if (stopping) {
      // Fatal faults must escalate an in-progress clean stop to failure.
      if (stoppedExitCode !== 0 && exitCode === 0) {
        exitCode = stoppedExitCode
        onFailed?.()
        markFailed()
      }
      return false
    }
    stopping = true
    holdOrcadTerminalAdmissionUntilExit()
    exitCode = stoppedExitCode
    retractClean = onFailed
    setTimeout(() => {
      console.error(`orcad: shutdown after ${signal} exceeded ${deadlineMs}ms — exiting`)
      markFailed()
      process.exit(1)
    }, deadlineMs)
    stop()
      .then(() => process.exit(exitCode))
      .catch((error) => {
        console.error(`orcad: shutdown after ${signal} failed:`, error)
        markFailed()
        process.exit(resolveOrcadExitCode(error))
      })
    return true
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  // Survive terminal hangups; INT/TERM request graceful shutdown.
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
  const runtime = new OrcadRuntimeLifetime()
  const cleanup = createIdempotentOrcadCleanup(async () => {
    // Stamp quit before awaiting teardown so dying chat agents read as restart rather than crash.
    recordAgentSessionRuntimeEnd('quit')
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
      // Preserve the startup fault while recording cleanup failures.
      console.error('[orcad] startup cleanup failed:', cleanupError)
    }
    throw error
  }
}

/** Keep profile admission/lock until all runtime writers stop. */
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
      // Browser authorization UI must not block RPC readiness.
      browserProvider = startOrcadBrowserProvider({ userDataPath })
      // Only managed hosts have opted-in desktop bridges; user-started hosts route to paired page hosts.
      setDesktopBrowserBridgeHostEnabled(Boolean(process.env[ORCAD_MANAGED_ACTIVATION_ROOT_ENV]))
      return { ...(await start(registerCleanup)), instance }
    },
    async (runtimeCleanupSucceeded) => {
      // Failed cleanup retains both ownership fences until process exit.
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
      host.add(() => setDesktopBrowserBridgeHostEnabled(false))
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
