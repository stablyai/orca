import { chmod, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

export async function removeWorktreeCloneStaging(staging: string): Promise<void> {
  await removeOwnedStaging(staging).catch((error) => {
    console.warn(
      `[worktree-symlinks] Could not remove clone staging directory "${staging}":`,
      error
    )
  })
}

async function removeOwnedStaging(staging: string): Promise<void> {
  const pending = [staging]
  for (let directory = pending.pop(); directory !== undefined; directory = pending.pop()) {
    // Only directories: staged regular files may already be linked into the destination.
    await chmod(directory, 0o700)
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        pending.push(join(directory, entry.name))
      }
    }
  }
  await rm(staging, { recursive: true, force: true })
}
