// Physical byte accounting for one session journal.

import { constants } from 'node:fs'
import { open, readdir } from 'node:fs/promises'
import { join } from 'node:path'

/** Count every regular file the session owns, including crash-left temp and
 * unknown residue. Unexpected links or nested directories fail closed. */
export async function journalStorageFootprint(journalDir: string): Promise<number> {
  const entries = await readdir(journalDir, { withFileTypes: true })
  let total = 0
  for (const entry of entries) {
    const path = join(journalDir, entry.name)
    if (entry.name === 'blobs') {
      if (!entry.isDirectory()) {
        throw new Error('agent-session blob store is not a directory')
      }
      total += await flatDirectoryFootprint(path)
      continue
    }
    if (!entry.isFile()) {
      throw new Error(`unexpected non-file in agent-session journal: ${entry.name}`)
    }
    total += await regularFileByteLength(path, entry.name)
  }
  return total
}

async function flatDirectoryFootprint(directory: string): Promise<number> {
  const entries = await readdir(directory, { withFileTypes: true })
  let total = 0
  for (const entry of entries) {
    if (!entry.isFile()) {
      throw new Error(`unexpected non-file in agent-session blob store: ${entry.name}`)
    }
    total += await regularFileByteLength(join(directory, entry.name), entry.name)
  }
  return total
}

async function regularFileByteLength(path: string, label: string): Promise<number> {
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    if (isMissing(error)) {
      return 0
    }
    throw error
  }
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.nlink !== 1) {
      throw new Error(`journal storage entry ${label} is not a regular single-link file`)
    }
    return info.size
  } finally {
    await handle.close()
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}
