import { readlink, symlink } from 'node:fs/promises'

const COMMIT_MARKER_TARGET = 'orca-singleton-recovery-commit-v1'

export function createSingletonRecoveryCommitMarker(path: string): Promise<void> {
  return symlink(COMMIT_MARKER_TARGET, path)
}

export async function hasCommittedSingletonRecoveryMarker(path: string): Promise<boolean> {
  try {
    return (await readlink(path)) === COMMIT_MARKER_TARGET
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error.code === 'ENOENT' || error.code === 'EINVAL')
    ) {
      return false
    }
    throw error
  }
}
