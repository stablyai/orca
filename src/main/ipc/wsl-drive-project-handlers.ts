/**
 * IPC for converting a WSL-runtime project on a Windows drive to Windows Git (D1c). Refused while
 * the internal WSL hosts gate is closed or off Windows, before anything is read.
 */
import { join } from 'node:path'
import { ipcMain } from 'electron'
import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { registerWslDriveUncConversionHandlers } from './wsl-drive-unc-conversion-handlers'
import { gitExecFileAsync } from '../git/command-runner/git-exec-file'
import { readWorktreeLinks as readWorktreeAdminLinks } from '../git/worktree-prune-guard'
import { resolveLocalProjectRuntimeForProject } from '../local-project-runtime-resolution'
import { wslHostsGateOpen } from '../wsl/wsl-host-gate'
import {
  convertWslDriveProjectToWindowsGit,
  previewWslDriveProjectWindowsGit,
  type WslDriveProjectDeps
} from '../wsl/wsl-drive-project-windows-git'

export const WSL_DRIVE_PROJECT_HANDLER_CHANNELS = [
  'wslDriveProject:preview',
  'wslDriveProject:convert'
] as const

export function registerWslDriveProjectHandlers(store: Store, runtime: OrcaRuntimeService): void {
  for (const channel of WSL_DRIVE_PROJECT_HANDLER_CHANNELS) {
    ipcMain.removeHandler(channel)
  }
  registerWslDriveUncConversionHandlers(store, runtime)
  ipcMain.handle('wslDriveProject:preview', async (_event, projectId: unknown) =>
    previewWslDriveProjectWindowsGit(gatedDeps(store), requireId(projectId))
  )
  ipcMain.handle('wslDriveProject:convert', async (_event, args: unknown) => {
    const request = typeof args === 'object' && args !== null ? args : {}
    const alignLineEndings = 'alignLineEndings' in request && request.alignLineEndings === true
    return convertWslDriveProjectToWindowsGit(
      gatedDeps(store),
      requireId('projectId' in request ? request.projectId : undefined),
      { alignLineEndings }
    )
  })
}

function requireId(value: unknown): string {
  if (typeof value !== 'string' || !value) {
    throw new Error('wsl_drive_project_invalid_args')
  }
  return value
}

function gatedDeps(store: Store): WslDriveProjectDeps {
  if (process.platform !== 'win32' || !wslHostsGateOpen()) {
    throw new Error('wsl_drive_project_unavailable')
  }
  return {
    getProjects: () => store.getProjects(),
    getRepos: () => store.getRepos(),
    resolveRuntime: (project) => {
      const runtime = resolveLocalProjectRuntimeForProject(store, project)
      if (!runtime) {
        throw new Error('wsl_drive_project_runtime_unresolved')
      }
      return runtime
    },
    // No wslDistro: this runs the host's Git even for a WSL-runtime project.
    runWindowsGit: async (args, cwd) => (await gitExecFileAsync(args, { cwd })).stdout,
    readWorktreeLinks
  }
}

export async function readWorktreeLinks(commonDir: string): Promise<string[]> {
  return (await readWorktreeAdminLinks(join(commonDir, 'worktrees'))).map(({ link }) => link)
}
