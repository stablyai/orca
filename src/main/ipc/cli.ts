import { ipcMain } from 'electron'
import type { CliInstallStatus } from '../../shared/cli-install-types'
import { CliInstaller } from '../cli/cli-installer'
import {
  inspectAndRepairLocalCliStatus,
  resetStaleAppImageRepairState,
  runLocalCliRegistrationOperation
} from '../cli/local-cli-registration-coordinator'
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
import { getCanonicalUserDataPath } from '../persistence/loading-store/user-data-path'
import { hydrateShellPath, mergePathSegments } from '../startup/hydrate-shell-path'
import { getDefaultWslDistro } from '../wsl/discovery/distro-catalog'
import {
  blockedWslDistroForExec,
  runAsWslExecUserAct
} from '../wsl/discovery/wsl-background-exec-gate'
import { isWslDistroNotFoundFailure } from '../wsl/discovery/wsl-distro-unsupported'

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
  resetStaleAppImageRepairState()

  ipcMain.handle('cli:getInstallStatus', async (): Promise<CliInstallStatus> => {
    await hydrateLocalShellPathForCli()
    return inspectAndRepairLocalCliStatus()
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
