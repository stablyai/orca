import { rename } from 'node:fs/promises'
import { normalize } from 'node:path'
import { assertNoClobberRenameDestinationAvailable } from '../shared/filesystem-rename-collision'

const pendingRenamesByDestination = new Map<string, Promise<void>>()

function destinationKey(filePath: string): string {
  // Why: lower-then-upper covers native full-case aliases such as ß/SS, unlike lowercase alone.
  return normalize(filePath).normalize('NFD').toLowerCase().toUpperCase().normalize('NFD')
}

export async function renameLocalPathSerializedByDestination(
  oldPath: string,
  newPath: string
): Promise<void> {
  const key = destinationKey(newPath)
  const previous = pendingRenamesByDestination.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  pendingRenamesByDestination.set(key, current)

  await previous
  try {
    await assertNoClobberRenameDestinationAvailable(oldPath, newPath)
    await rename(oldPath, newPath)
  } finally {
    release()
    if (pendingRenamesByDestination.get(key) === current) {
      pendingRenamesByDestination.delete(key)
    }
  }
}
