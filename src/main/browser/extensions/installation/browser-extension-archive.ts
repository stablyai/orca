import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { unzipSync } from 'fflate'

/** Unpacks a verified CRX's zip archive without letting any entry land outside the target folder. */

const MAX_ENTRIES = 20_000
const MAX_UNPACKED_BYTES = 512 * 1024 * 1024

export type BrowserExtensionArchiveEntry = { path: string; data: Uint8Array }

/** Relative, forward-slash names only: no absolute paths, drive letters, backslashes or `..`. */
export function isSafeArchiveEntryName(name: string): boolean {
  if (!name || name.length > 1024 || name.includes('\0') || name.includes('\\')) {
    return false
  }
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) {
    return false
  }
  const segments = name.replace(/\/$/, '').split('/')
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}

/** Files in the archive, after rejecting any unsafe name or an archive too large to unpack. */
export function readBrowserExtensionArchive(archive: Uint8Array): BrowserExtensionArchiveEntry[] {
  let declaredBytes = 0
  const seen = new Set<string>()
  // Why throw inside the filter: it runs before each entry inflates, so a bomb never expands.
  const files = unzipSync(archive, {
    filter: (file) => {
      declaredBytes += file.originalSize
      if (!isSafeArchiveEntryName(file.name) || seen.has(file.name)) {
        throw new Error(`Extension package has an unsafe file name: ${JSON.stringify(file.name)}`)
      }
      seen.add(file.name)
      if (seen.size > MAX_ENTRIES || declaredBytes > MAX_UNPACKED_BYTES) {
        throw new Error('Extension package is too large')
      }
      return !file.name.endsWith('/')
    }
  })
  const entries = Object.entries(files).map(([path, data]) => ({ path, data }))
  if (entries.reduce((total, entry) => total + entry.data.byteLength, 0) > MAX_UNPACKED_BYTES) {
    throw new Error('Extension package is too large')
  }
  return entries
}

/** Writes entries under `directory`, re-checking each resolved path stays inside it. */
export async function writeBrowserExtensionArchive(
  entries: BrowserExtensionArchiveEntry[],
  directory: string
): Promise<void> {
  const root = resolve(directory)
  await mkdir(root, { recursive: true })
  for (const entry of entries) {
    const target = resolve(root, entry.path)
    const rel = relative(root, target)
    if (!isSafeArchiveEntryName(entry.path) || !rel || rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`Extension package has an unsafe file name: ${JSON.stringify(entry.path)}`)
    }
    await mkdir(dirname(target), { recursive: true })
    // Why 'wx': a duplicate name in the archive must fail rather than overwrite.
    await writeFile(target, entry.data, { flag: 'wx' })
  }
}
