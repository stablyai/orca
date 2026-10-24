/**
 * IPC for converting UNC Windows-drive projects to their drive paths (D1c), and what the last
 * startup did with a journaled conversion. Refused off Windows and while the internal WSL hosts
 * gate is closed, before anything is read.
 */
import { randomUUID } from 'node:crypto'
import { app, ipcMain, type IpcMainInvokeEvent } from 'electron'
import type {
  WslDriveUncConversionRequest,
  WslDriveUncConversionResult
} from '../../shared/wsl-drive-unc-conversion-types'
import { relaunchApp } from '../app-relaunch'
import { gitExecFileAsync } from '../git/command-runner/git-exec-file'
import { readProfileProjectTransferState } from '../orca-profiles/profile-project-domain-state'
import { getOrcaProfileListState } from '../orca-profiles/profile-index-store'
import { getProfileUserDataPath } from '../orca-profiles/profile-storage-paths'
import type { Store } from '../persistence'
import { pauseWslMoveScope } from '../persistence/moving-wsl-projects/wsl-move-driver-pause'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { quitProcess } from '../startup/process-quit-request'
import { startWslDriveUncConversion } from '../wsl/wsl-drive-unc-conversion-run'
import {
  lastWslDriveUncConversionOutcomes,
  type WslDriveUncConversionOutcome
} from '../wsl/wsl-drive-unc-conversion-startup'
import { wslHostsGateOpen } from '../wsl/wsl-host-gate'
import { createWslMoveDriverDeps } from './wsl-move-driver-wiring'
import { readWorktreeLinks } from './wsl-drive-project-handlers'

export const WSL_DRIVE_UNC_CONVERSION_CHANNELS = [
  'wslDriveUnc:convert',
  'wslDriveUnc:lastOutcomes'
] as const

export function registerWslDriveUncConversionHandlers(
  store: Store,
  runtime: OrcaRuntimeService
): void {
  for (const channel of WSL_DRIVE_UNC_CONVERSION_CHANNELS) {
    ipcMain.removeHandler(channel)
  }
  ipcMain.handle(
    'wslDriveUnc:convert',
    async (event: IpcMainInvokeEvent, args: unknown): Promise<WslDriveUncConversionResult> => {
      assertAvailable()
      const request = parseRequest(args)
      const userDataPath = app.getPath('userData')
      return startWslDriveUncConversion(
        {
          userDataPath,
          readProfileState: async () => {
            await store.flushPendingOrThrowAsync()
            const { activeProfileId } = getOrcaProfileListState()
            return readProfileProjectTransferState(activeProfileId, getProfileUserDataPath()).state
          },
          pause: (scope) => pauseWslMoveScope(createWslMoveDriverDeps(store, runtime), scope),
          // No wslDistro: this runs the host's Git, in the drive path.
          runWindowsGit: async (gitArgs, cwd) => (await gitExecFileAsync(gitArgs, { cwd })).stdout,
          readWorktreeLinks,
          restart: () => {
            if (!event.sender.isDestroyed()) {
              event.sender.send('app:restart-committed')
            }
            // Quit, not exit: the window and the store flush the slept panes on the way out.
            setTimeout(() => {
              relaunchApp('wsl-drive-conversion')
              quitProcess()
            }, 150)
          },
          newMigrationId: () => randomUUID(),
          now: () => new Date()
        },
        request
      )
    }
  )
  ipcMain.handle('wslDriveUnc:lastOutcomes', (): WslDriveUncConversionOutcome[] =>
    process.platform === 'win32' && wslHostsGateOpen() ? lastWslDriveUncConversionOutcomes() : []
  )
}

function assertAvailable(): void {
  if (process.platform !== 'win32' || !wslHostsGateOpen()) {
    throw new Error('wsl_drive_unc_unavailable')
  }
}

function parseRequest(value: unknown): WslDriveUncConversionRequest {
  const record = typeof value === 'object' && value !== null ? value : {}
  const distro = 'distro' in record ? record.distro : undefined
  const repoIds = 'repoIds' in record ? record.repoIds : undefined
  const folderWorkspaceIds = 'folderWorkspaceIds' in record ? record.folderWorkspaceIds : []
  if (
    typeof distro !== 'string' ||
    !distro ||
    !isIdList(repoIds) ||
    !isIdList(folderWorkspaceIds)
  ) {
    throw new Error('wsl_drive_unc_invalid_args')
  }
  return { distro, repoIds, folderWorkspaceIds }
}

function isIdList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((id) => typeof id === 'string' && id.length > 0)
}
