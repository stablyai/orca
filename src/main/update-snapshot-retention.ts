import { lstat, readdir, readFile, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'

/** Retain the new recovery point and the newest previous completed backup. */
export async function pruneUpdateSnapshots(root: string, current: string): Promise<void> {
  const completed: string[] = []
  for (const name of await readdir(root)) {
    if (!/^\d+-[a-f0-9-]{36}$/.test(name) || name === basename(current)) {
      continue
    }
    const path = join(root, name)
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink()) {
      continue
    }
    try {
      const manifest = JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8'))
      if (manifest.format === 1 && Array.isArray(manifest.entries)) {
        completed.push(name)
      }
    } catch {
      // An incomplete directory may still belong to an active backup writer.
    }
  }
  completed.sort((a, b) => Number(b.split('-')[0]) - Number(a.split('-')[0]))
  for (const name of completed.slice(1)) {
    const path = join(root, name)
    const info = await lstat(path)
    if (info.isDirectory() && !info.isSymbolicLink()) {
      await rm(path, { recursive: true, force: true })
    }
  }
}
