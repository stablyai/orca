import { ipcMain } from 'electron'
import type { CliInstallStatus } from '../../shared/cli-install-types'
import { resolveAppImageCacheKey } from '../cli/appimage-extracted-root'
import { CliInstaller } from '../cli/cli-installer'
import { runKeyedSerializedOperation } from '../cli/keyed-promise-queue'
import {
  forgetWslCliRegistration,
  recordWslCliRegistrationInstalled,
  recordWslCliRegistrationRemoved
} from '../cli/wsl-cli-registration-registry'
import { WslCliInstaller } from '../cli/wsl-cli-installer'
import {
  deletedDistroWslCliStatus,
  notRunningWslCliStatus,
  unreachableWslCliStatus,
  WslCliUnreachableError
} from '../cli/wsl-cli-status'
import { runSerializedWslCliRegistrationOperation } from '../cli/wsl-cli-registration-operation'
import { getCanonicalUserDataPath } from '../persistence'
import { hydrateShellPath, mergePathSegments } from '../startup/hydrate-shell-path'
import { getDefaultWslDistro } from '../wsl'
import { blockedWslDistroForExec, runAsWslExecUserAct } from '../wsl/wsl-background-exec-gate'
import { isWslDistroNotFoundFailure } from '../wsl/wsl-distro-unsupported'
import { resolveAppImageRuntimeIdentity } from '../appimage-runtime-identity'

const APPIMAGE_REPAIR_RETRY_MS = 30_000
const localCliRegistrationQueues = new Map<string, Promise<void>>()

function runLocalCliRegistrationOperation<T>(operation: () => Promise<T>): Promise<T> {
  return runKeyedSerializedOperation(localCliRegistrationQueues, 'local', operation)
}

function resolveStaleAppImageRepairKey(status: CliInstallStatus): string | null {
  if (status.state !== 'stale') {
    return null
  }
  const runtimeIdentity = resolveAppImageRuntimeIdentity()
  if (!runtimeIdentity) {
    return null
  }
  const cacheKey = resolveAppImageCacheKey(runtimeIdentity.appImagePath)
  if (!cacheKey) {
    return null
  }
  return [status.commandPath, status.launcherPath, runtimeIdentity.appImagePath, cacheKey].join(
    '\0'
  )
}

function normalizeWslCliDistro(args?: { distro?: string | null }): string | undefined {
  return args?.distro?.trim() || undefined
}

function resolveWslCliDistro(args?: { distro?: string | null }): string | null {
  return normalizeWslCliDistro(args) ?? getDefaultWslDistro()
}

function runWslCliRegistrationOperation<T>(
  distro: string | null,
  operation: () => Promise<T>
): Promise<T> {
  return distro ? runSerializedWslCliRegistrationOperation(distro, operation) : operation()
}

async function persistWslCliRegistration(
  operation: () => Promise<void>,
  action: 'install' | 'remove'
): Promise<void> {
  try {
    await operation()
  } catch (error) {
    // Advisory metadata failure must not invalidate the completed WSL write; startup repair reads authoritative disk state.
    console.warn(
      `[wsl-cli] Failed to persist ${action} registration metadata:`,
      error instanceof Error ? error.message : String(error)
    )
  }
}

async function hydrateLocalShellPathForCli(force = false): Promise<void> {
  if (process.platform === 'win32') {
    return
  }
  // Match terminal PATH rather than the sparse environment inherited by GUI Electron.
  const hydration = await hydrateShellPath(force ? { force: true } : undefined)
  if (hydration.ok) {
    mergePathSegments(hydration.segments)
  }
}

export function registerCliHandlers(): void {
  let staleAppImageRepairAttempt: {
    promise: Promise<CliInstallStatus | null>
    retryAfter: number
  } | null = null

  ipcMain.handle('cli:getInstallStatus', async (): Promise<CliInstallStatus> => {
    await hydrateLocalShellPathForCli()
    const installer = new CliInstaller()
    const status = await installer.getStatus()
    // AppImage updates replace the outer file while managed links can retain the old extracted payload.
    const repairKey = resolveStaleAppImageRepairKey(status)
    if (!repairKey || installer.isAppImageRegistrationOwnedBySibling(status)) {
      return status
    }

    if (!staleAppImageRepairAttempt || Date.now() >= staleAppImageRepairAttempt.retryAfter) {
      const promise = runLocalCliRegistrationOperation(async () => {
        const currentInstaller = new CliInstaller()
        const currentStatus = await currentInstaller.getStatus()
        return resolveStaleAppImageRepairKey(currentStatus) === repairKey &&
          !currentInstaller.isAppImageRegistrationOwnedBySibling(currentStatus)
          ? currentInstaller.install()
          : currentStatus
      }).catch((error) => {
        console.warn(
          '[cli] Failed to repair stale AppImage registration:',
          error instanceof Error ? error.message : String(error)
        )
        return null
      })
      staleAppImageRepairAttempt = { promise, retryAfter: Number.POSITIVE_INFINITY }
      void promise.then((result) => {
        if (staleAppImageRepairAttempt?.promise !== promise) {
          return
        }
        staleAppImageRepairAttempt = result
          ? null
          : { ...staleAppImageRepairAttempt, retryAfter: Date.now() + APPIMAGE_REPAIR_RETRY_MS }
      })
    }
    return (await staleAppImageRepairAttempt.promise) ?? status
  })

  ipcMain.handle('cli:install', async (): Promise<CliInstallStatus> => {
    await hydrateLocalShellPathForCli(true)
    return runLocalCliRegistrationOperation(() => new CliInstaller().install())
  })

  ipcMain.handle('cli:remove', async (): Promise<CliInstallStatus> => {
    await hydrateLocalShellPathForCli()
    return runLocalCliRegistrationOperation(() => new CliInstaller().remove())
  })

  ipcMain.handle(
    'cli:getWslInstallStatus',
    async (
      _event,
      args?: { distro?: string | null; wakeWslDistro?: boolean }
    ): Promise<CliInstallStatus> => {
      // Keep status reads independent of long repairs; re-polling corrects transient state.
      const distro = resolveWslCliDistro(args)
      const readStatus = async (): Promise<CliInstallStatus> => {
        // Opening Settings must not start a stopped distro (E9); its refresh button wakes it.
        const blocked = await blockedWslDistroForExec(distro)
        if (blocked) {
          return notRunningWslCliStatus(blocked.distro, blocked.state)
        }
        try {
          return await new WslCliInstaller({ distro }).getStatus()
        } catch (error) {
          // Cold/busy distros are retryable Settings states, not raw IPC failures (#29497).
          if (distro && error instanceof WslCliUnreachableError) {
            return unreachableWslCliStatus(distro)
          }
          throw error
        }
      }
      return args?.wakeWslDistro ? runAsWslExecUserAct(distro, readStatus) : readStatus()
    }
  )

  ipcMain.handle(
    'cli:installWsl',
    async (_event, args?: { distro?: string | null }): Promise<CliInstallStatus> => {
      const distro = resolveWslCliDistro(args)
      return runWslCliRegistrationOperation(distro, async () => {
        const status = await new WslCliInstaller({ distro }).install()
        if (distro && status.state === 'installed') {
          await persistWslCliRegistration(
            () => recordWslCliRegistrationInstalled(getCanonicalUserDataPath(), distro),
            'install'
          )
        }
        return status
      })
    }
  )

  ipcMain.handle(
    'cli:removeWsl',
    async (_event, args?: { distro?: string | null }): Promise<CliInstallStatus> => {
      const distro = resolveWslCliDistro(args)
      return runWslCliRegistrationOperation(distro, async () => {
        let status: CliInstallStatus
        try {
          status = await new WslCliInstaller({ distro }).remove()
        } catch (error) {
          if (!distro || !isWslDistroNotFoundFailure(error)) {
            throw error
          }
          // Nothing is left inside a deleted distro; only Orca's bookkeeping still names it.
          await persistWslCliRegistration(
            () => forgetWslCliRegistration(getCanonicalUserDataPath(), distro),
            'remove'
          )
          return deletedDistroWslCliStatus(distro)
        }
        if (distro && status.state === 'not_installed') {
          await persistWslCliRegistration(
            () => recordWslCliRegistrationRemoved(getCanonicalUserDataPath(), distro),
            'remove'
          )
        }
        return status
      })
    }
  )
}
