import { accessSync, constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { isLaunchFileRefusal } from '../../shared/launch-prompt-file'
import type { WslLaunchDirectory } from '../../shared/wsl-launch-directory'
import {
  noteWslLaunchDirectoryRefusal,
  WSL_LAUNCH_DIRECTORY_FAILURE_TTL_MS
} from './wsl-launch-directory-resolution'

let refusedAt: number | null = null

/** Whether this machine can write its temp folder, where staged lines and launch files go. A write
 *  refused there counts for the failure TTL, then the folder is checked again. */
export function localLaunchArtifactsWritable(now = Date.now()): boolean {
  if (refusedAt !== null && now - refusedAt < WSL_LAUNCH_DIRECTORY_FAILURE_TTL_MS) {
    return false
  }
  try {
    accessSync(tmpdir(), constants.W_OK)
    return true
  } catch {
    return false
  }
}

/** A spawn refused for its staged line or launch file: the folder it wrote to counts as broken,
 *  so the next launch is planned without writing there. */
export function noteLaunchArtifactRefusal(
  spawn: {
    wslDistro: string | null | undefined
    wslLaunchDirectory: WslLaunchDirectory | undefined
  },
  error: unknown
): void {
  if (spawn.wslDistro) {
    noteWslLaunchDirectoryRefusal(spawn.wslLaunchDirectory, error)
  } else if (isLaunchFileRefusal(error)) {
    refusedAt = Date.now()
  }
}
