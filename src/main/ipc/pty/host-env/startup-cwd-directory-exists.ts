import { stat } from 'node:fs/promises'
import { isWslUncPath } from '../../../../shared/wsl-paths'
import { wslUncDirectoryExistsAsync } from '../../../wsl'

export async function probeLocalStartupCwdDirectory(path: string): Promise<boolean | null> {
  try {
    return (await stat(path)).isDirectory()
  } catch (error) {
    // Saved-folder correction and recovered-path relocation require proof of absence.
    return error &&
      typeof error === 'object' &&
      'code' in error &&
      (error.code === 'ENOENT' || error.code === 'ENOTDIR')
      ? false
      : null
  }
}

export function probeRecoveredStartupCwdDirectory(path: string): Promise<boolean | null> {
  return isWslUncPath(path) ? wslUncDirectoryExistsAsync(path) : probeLocalStartupCwdDirectory(path)
}
