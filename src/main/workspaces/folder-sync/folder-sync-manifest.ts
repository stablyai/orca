import { createHash } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import type { FolderSyncManifest } from '../../../shared/project/folder-project-sync'
import { windowsFsPath } from '../../wsl/filesystem/wsl-unc-drive-fs-path'

const MAX_MANIFEST_ENTRIES = 10_000
const MAX_MANIFEST_PATH_BYTES = 1024 * 1024
const MAX_CACHED_ROOTS = 8
type FileEntry = Extract<FolderSyncManifest[number][1], { kind: 'file' }>
type CachedFile = { stat: Stats; entry: FileEntry }
const fingerprintsByRoot = new Map<string, Map<string, CachedFile>>()

export const FOLDER_SYNC_TEMP_PREFIX = '.orca-folder-sync-'

export function isFolderSyncName(name: string): boolean {
  return (
    name !== '' &&
    name !== '.' &&
    name !== '..' &&
    name.toLowerCase() !== '.git' &&
    !name.startsWith(FOLDER_SYNC_TEMP_PREFIX) &&
    !/[ .]$/.test(name) &&
    !Array.from(name).some((character) => character.charCodeAt(0) < 32) &&
    !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name) &&
    !/[\\/:<>"|?*]/.test(name)
  )
}

export async function scanFolderSyncManifest(
  rootPath: string,
  signal?: AbortSignal
): Promise<FolderSyncManifest> {
  const root = await realpath(windowsFsPath(rootPath))
  const entries: FolderSyncManifest = []
  const prior = fingerprintsByRoot.get(root)
  const fingerprints = new Map<string, CachedFile>()
  let pathBytes = 0

  async function visit(relative: string): Promise<void> {
    signal?.throwIfAborted()
    const directory = join(root, relative)
    for (const item of await readdir(directory, { withFileTypes: true })) {
      if (item.name.toLowerCase() === '.git' || item.name.startsWith(FOLDER_SYNC_TEMP_PREFIX)) {
        continue
      }
      const path = relative ? `${relative}/${item.name}` : item.name
      pathBytes += Buffer.byteLength(path)
      if (entries.length >= MAX_MANIFEST_ENTRIES || pathBytes > MAX_MANIFEST_PATH_BYTES) {
        throw new Error('Folder project is too large to sync.')
      }
      if (!isFolderSyncName(item.name) || (!item.isDirectory() && !item.isFile())) {
        entries.push([path, { kind: 'blocked' }])
        continue
      }
      if (item.isDirectory()) {
        entries.push([path, { kind: 'directory' }])
        const child = join(root, path)
        if ((await lstat(child)).isSymbolicLink() || (await realpath(child)) !== child) {
          throw new Error('Folder changed while scanning for sync.')
        }
        await visit(path)
      } else {
        const stat = await lstat(join(root, path))
        const cached = prior?.get(path)
        const entry =
          cached && sameFile(stat, cached.stat)
            ? cached.entry
            : await fingerprintFolderSyncFile(root, path, signal)
        entries.push([path, entry])
        fingerprints.set(path, { stat, entry })
      }
    }
  }

  await visit('')
  fingerprintsByRoot.delete(root)
  fingerprintsByRoot.set(root, fingerprints)
  if (fingerprintsByRoot.size > MAX_CACHED_ROOTS) {
    const oldest = fingerprintsByRoot.keys().next()
    if (!oldest.done) {
      fingerprintsByRoot.delete(oldest.value)
    }
  }
  return entries.sort(([a], [b]) => a.localeCompare(b))
}

function sameFile(a: Stats, b: Stats): boolean {
  return (
    a.isFile() &&
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs &&
    a.size === b.size &&
    a.mode === b.mode
  )
}

export async function fingerprintFolderSyncFile(
  root: string,
  relativePath: string,
  signal?: AbortSignal
): Promise<FileEntry> {
  const path = join(root, relativePath)
  if (!(await lstat(path)).isFile() || (await realpath(path)) !== path) {
    throw new Error('File changed while scanning for sync.')
  }
  const file = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | constants.O_NONBLOCK
  )
  try {
    const before = await file.stat()
    if (!before.isFile()) {
      throw new Error('Expected a regular file while scanning for sync.')
    }
    const hash = createHash('sha256')
    for await (const bytes of file.createReadStream({ autoClose: false })) {
      signal?.throwIfAborted()
      hash.update(bytes)
    }
    const after = await file.stat()
    if (!sameFile(before, after)) {
      throw new Error('File changed while scanning for sync.')
    }
    return {
      kind: 'file',
      hash: hash.digest('hex'),
      size: after.size,
      executable: Boolean(after.mode & 0o111)
    }
  } finally {
    await file.close()
  }
}
