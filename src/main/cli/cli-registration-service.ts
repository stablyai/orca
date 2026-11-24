import type { CliInstallStatus } from '../../shared/cli/cli-install-types'
import { resolveAppImageCacheKeyAsync } from '../../shared/desktop-distribution/appimage/appimage-cache-identity'
import { CliInstaller } from './cli-installer'
import { runKeyedSerializedOperation } from '../../shared/concurrency/keyed-serialized-operations'
import {
  recordWslCliRegistrationInstalled,
  recordWslCliRegistrationRemoved
} from './wsl/wsl-cli-registration-registry'
import { unreachableWslCliStatus, WslCliUnreachableError } from './wsl/wsl-cli-status'
import { WslCliInstaller } from './wsl/wsl-cli-installer'
import { runSerializedWslCliRegistrationOperation } from './wsl/wsl-cli-registration-operation'
import { getCanonicalUserDataPath } from '../persistence/loading-store/user-data-path'
import {
  hydrateShellPath,
  mergePathSegments
} from '../startup/shell-environment/hydrate-shell-path'
import { getDefaultWslDistro } from '../wsl/discovery/distro-catalog'
import { resolveAppImageRuntimeIdentityAsync } from '../updater/linux-package/appimage-runtime-identity'

const APPIMAGE_REPAIR_RETRY_MS = 30_000
const localCliRegistrationQueues = new Map<string, Promise<void>>()

export type CliRegistrationService = {
  getCliInstallStatus(): Promise<CliInstallStatus>
  installCli(): Promise<CliInstallStatus>
  removeCli(): Promise<CliInstallStatus>
  getWslCliInstallStatus(args?: { distro?: string | null }): Promise<CliInstallStatus>
  installWslCli(args?: { distro?: string | null }): Promise<CliInstallStatus>
  removeWslCli(args?: { distro?: string | null }): Promise<CliInstallStatus>
}

function runLocalCliRegistrationOperation<T>(operation: () => Promise<T>): Promise<T> {
  return runKeyedSerializedOperation(localCliRegistrationQueues, 'local', operation)
}

async function resolveStaleAppImageRepairKey(status: CliInstallStatus): Promise<string | null> {
  if (status.state !== 'stale') {
    return null
  }
  const runtimeIdentity = await resolveAppImageRuntimeIdentityAsync()
  if (!runtimeIdentity) {
    return null
  }
  const cacheKey = await resolveAppImageCacheKeyAsync(runtimeIdentity.appImagePath)
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
    // Why: the WSL file operation already succeeded; advisory metadata must not turn that
    // success into a false Settings failure. The next startup probe repairs stale metadata.
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
  // Why: CLI registration must match `which orca` in the user's terminal, not the sparse PATH
  // a GUI-launched host inherited from launchd.
  const hydration = await hydrateShellPath(force ? { force: true } : undefined)
  if (hydration.ok) {
    mergePathSegments(hydration.segments)
  }
}

export function createCliRegistrationService(): CliRegistrationService {
  let staleAppImageRepairAttempt: {
    promise: Promise<CliInstallStatus | null>
    retryAfter: number
  } | null = null

  async function getCliInstallStatus(): Promise<CliInstallStatus> {
    await hydrateLocalShellPathForCli()
    const installer = new CliInstaller()
    const status = await installer.getStatus()
    // Why: an AppImage update replaces the outer file while the managed symlink still targets the prior extracted payload.
    const repairKey = await resolveStaleAppImageRepairKey(status)
    if (!repairKey || installer.isAppImageRegistrationOwnedBySibling(status)) {
      return status
    }

    if (!staleAppImageRepairAttempt || Date.now() >= staleAppImageRepairAttempt.retryAfter) {
      const promise = runLocalCliRegistrationOperation(async () => {
        const currentInstaller = new CliInstaller()
        const currentStatus = await currentInstaller.getStatus()
        return (await resolveStaleAppImageRepairKey(currentStatus)) === repairKey &&
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

  async function installCli(): Promise<CliInstallStatus> {
    await hydrateLocalShellPathForCli(true)
    return runLocalCliRegistrationOperation(() => new CliInstaller().install())
  }

  async function removeCli(): Promise<CliInstallStatus> {
    await hydrateLocalShellPathForCli()
    return runLocalCliRegistrationOperation(() => new CliInstaller().remove())
  }

  async function getWslCliInstallStatus(args?: {
    distro?: string | null
  }): Promise<CliInstallStatus> {
    // Why: status is a read-only probe; it must not wait behind a long install or repair.
    const distro = resolveWslCliDistro(args)
    try {
      return await new WslCliInstaller({ distro }).getStatus()
    } catch (error) {
      if (distro && error instanceof WslCliUnreachableError) {
        return unreachableWslCliStatus(distro)
      }
      throw error
    }
  }

  async function installWslCli(args?: { distro?: string | null }): Promise<CliInstallStatus> {
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

  async function removeWslCli(args?: { distro?: string | null }): Promise<CliInstallStatus> {
    const distro = resolveWslCliDistro(args)
    return runWslCliRegistrationOperation(distro, async () => {
      const status = await new WslCliInstaller({ distro }).remove()
      if (distro && status.state === 'not_installed') {
        await persistWslCliRegistration(
          () => recordWslCliRegistrationRemoved(getCanonicalUserDataPath(), distro),
          'remove'
        )
      }
      return status
    })
  }

  return {
    getCliInstallStatus,
    installCli,
    removeCli,
    getWslCliInstallStatus,
    installWslCli,
    removeWslCli
  }
}

const defaultCliRegistrationService = createCliRegistrationService()

export const getCliInstallStatus = defaultCliRegistrationService.getCliInstallStatus
export const installCli = defaultCliRegistrationService.installCli
export const removeCli = defaultCliRegistrationService.removeCli
export const getWslCliInstallStatus = defaultCliRegistrationService.getWslCliInstallStatus
export const installWslCli = defaultCliRegistrationService.installWslCli
export const removeWslCli = defaultCliRegistrationService.removeWslCli
