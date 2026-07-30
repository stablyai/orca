import { rename } from 'node:fs/promises'
import { dirname, normalize } from 'node:path'
import { assertNoClobberRenameDestinationAvailable } from '../shared/filesystem-rename-collision'

// Why: parent scope covers native Unicode aliases without guessing each filesystem's collation.
const pendingRenamesByParent = new Map<string, Promise<void>>()

function destinationParentKey(filePath: string): string {
  return normalize(dirname(filePath))
}

export async function renameLocalPathSerializedByDestination(
  oldPath: string,
  newPath: string
): Promise<void> {
  const key = destinationParentKey(newPath)
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
