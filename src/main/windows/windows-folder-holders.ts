import type { Dirent } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join, toNamespacedPath } from 'node:path'
import { readProcessIdsUsingPaths } from './windows-process-table'

// Why so few: each folder costs the kernel a walk of every handle on the system (~50 ms at 200k
// handles). Shells, agents, watchers and Explorer windows mostly sit at the top of a copy.
const DEFAULT_DEPTH = 2
const MAX_FOLDERS = 64

let warnedUnavailable = false

async function subfolders(dir: string): Promise<string[]> {
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  // Links and junctions report as links here, so the walk never leaves the folder.
  return entries.filter((entry) => entry.isDirectory()).map((entry) => join(dir, entry.name))
}

/** `root` and the folders down to `depth` levels below it, shallowest first. */
async function foldersUnder(root: string, depth: number): Promise<string[]> {
  const folders = [root]
  let level = [root]
  for (let step = 0; step < depth && level.length > 0 && folders.length < MAX_FOLDERS; step++) {
    level = (await Promise.all(level.map(subfolders))).flat().slice(0, MAX_FOLDERS - folders.length)
    folders.push(...level)
  }
  return folders
}

/**
 * Processes with a handle open on `root` or a folder near its top (a shell or agent working
 * there, an Explorer window, a folder watcher), each with the shallowest folder it holds. Null
 * where this host cannot ask.
 */
export async function readProcessesHoldingFolder(
  root: string,
  depth = DEFAULT_DEPTH
): Promise<Map<number, string> | null> {
  if (process.platform !== 'win32') {
    return null
  }
  const folders = await foldersUnder(root, depth)
  const query = readProcessIdsUsingPaths(folders.map((folder) => toNamespacedPath(folder)))
  if (!query) {
    if (!warnedUnavailable) {
      warnedUnavailable = true
      console.warn(
        '[windows-folder-holders] the windows-process-tree addon predates getProcessIdsUsingPaths; run pnpm install to rebuild it. Only programs naming a folder on their command line are found.'
      )
    }
    return null
  }
  const users = await query
  const holders = new Map<number, string>()
  folders.forEach((folder, index) => {
    for (const pid of users[index] ?? []) {
      if (!holders.has(pid)) {
        holders.set(pid, folder)
      }
    }
  })
  return holders
}
