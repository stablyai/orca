import { realpath, rename } from 'node:fs/promises'
import { dirname, normalize } from 'node:path'
import { assertNoClobberRenameDestinationAvailable } from '../shared/filesystem-rename-collision'
import { windowsFsPath } from './wsl/wsl-unc-drive-fs-path'

// Parent-scoped serialization covers Unicode aliases without guessing filesystem collation.
const pendingRenamesByParent = new Map<string, Promise<void>>()

function isENOENT(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  )
}

/** Canonical parent directory, the lock scope for local mutations that must not interleave. */
export async function serializedParentDirectoryKey(filePath: string): Promise<string> {
  const parentPath = dirname(filePath)
  try {
    return normalize(await realpath(parentPath))
  } catch (error) {
    // Keep missing-parent failures scoped to their destination so unrelated renames can proceed.
    if (isENOENT(error)) {
      return normalize(parentPath)
    }
    throw error
  }
}

export async function renameLocalPathSerializedByDestination(
  requestedOldPath: string,
  requestedNewPath: string
): Promise<void> {
  // UNC drive-mount paths open only through their drive paths.
  const oldPath = windowsFsPath(requestedOldPath)
  const newPath = windowsFsPath(requestedNewPath)
  const key = await serializedParentDirectoryKey(newPath)
  const previous = pendingRenamesByParent.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  pendingRenamesByParent.set(key, current)

  await previous
  try {
    await assertNoClobberRenameDestinationAvailable(oldPath, newPath)
    await rename(oldPath, newPath)
  } finally {
    release()
    if (pendingRenamesByParent.get(key) === current) {
      pendingRenamesByParent.delete(key)
    }
  }
}
