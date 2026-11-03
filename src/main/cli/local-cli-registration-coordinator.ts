import type { CliInstallStatus } from '../../shared/cli-install-types'
import { resolveAppImageRuntimeIdentity } from '../updater/linux-package/appimage-runtime-identity'
import { resolveAppImageCacheKey } from './appimage-extracted-root'
import { CliInstaller } from './cli-installer'
import { runKeyedSerializedOperation } from './keyed-promise-queue'

const APPIMAGE_REPAIR_RETRY_MS = 30_000
const localCliRegistrationQueues = new Map<string, Promise<void>>()

let staleAppImageRepairAttempt: {
  promise: Promise<CliInstallStatus | null>
  retryAfter: number
} | null = null

export function resetStaleAppImageRepairState(): void {
  staleAppImageRepairAttempt = null
}

export function runLocalCliRegistrationOperation<T>(operation: () => Promise<T>): Promise<T> {
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

export async function inspectAndRepairLocalCliStatus(): Promise<CliInstallStatus> {
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
}

/**
 * Repairs an already-registered Linux AppImage CLI launcher on desktop startup so an AppImage
 * auto-update or replacement does not leave `~/.local/bin/orca-ide` and `~/.local/bin/orca`
 * pointing at an older extracted generation until Settings is opened.
 */
export async function repairStaleLocalAppImageCliRegistration(): Promise<CliInstallStatus | null> {
  if (process.platform !== 'linux' || !resolveAppImageRuntimeIdentity()) {
    return null
  }
  try {
    return await inspectAndRepairLocalCliStatus()
  } catch (error) {
    console.warn(
      '[cli] Failed to inspect local AppImage CLI registration at startup:',
      error instanceof Error ? error.message : String(error)
    )
    return null
  }
}
