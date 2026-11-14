import { filesystemErrorCode } from './bundled-skill-filesystem-error'
import { moveAcrossFilesystems } from './bundled-skill-verified-backup'

import { constants, createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import {
  access,
  chmod,
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  writeFile
} from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  nativeSkillInstallFilesystem,
  type SkillDirectoryEntry,
  type SkillFilesystemEntryKind
} from '../filesystem/skill-install-filesystem'
import { createNativeSkillAlias } from '../filesystem/skill-native-alias'

export type BundledSkillPathStat = { kind: SkillFilesystemEntryKind; mtimeMs: number | null }

/** Host adapter for native/WSL/remote disks. Missing reads do not throw; failed writes do. */
export type BundledSkillFilesystem = {
  /** Whether this host can make a directory link; decided once, so `plan` never promises one it can't. */
  readonly supportsLinks: boolean
  /** `lstat` semantics; null when the path cannot be read at all. */
  stat(path: string): Promise<BundledSkillPathStat | null>
  readLink(path: string): Promise<string | null>
  realpath(path: string): Promise<string | null>
  /** `[]` for a missing directory, null when it cannot be listed. */
  listEntries(directory: string): Promise<SkillDirectoryEntry[] | null>
  /** Returns null when the file exceeds maxBytes; bounded reads never load the whole file. */
  readFile(path: string, maxBytes?: number): Promise<Buffer | null>
  /** Streaming digest when supported; adapters without it fall back to readFile. */
  hashFile?(path: string): Promise<string | null>
  /** Whether the nearest existing ancestor of `directory` accepts new entries. */
  canWrite(directory: string): Promise<boolean>
  /** Creates `path` (and missing parents) holding exactly `files`; dirs 0755, files 0644. */
  writeFolder(path: string, files: readonly { path: string; text: string }[]): Promise<void>
  /** Creates a private backup directory (0700 on POSIX), tightening existing permissions. */
  ensureDirectory(path: string): Promise<void>
  rename(source: string, target: string): Promise<void>
  /** Move into backups (copy/verify/remove across filesystems); directories become private. */
  moveToBackup(source: string, target: string): Promise<void>
  remove(path: string): Promise<void>
  createLink(target: string, linkPath: string): Promise<void>
}

function kindOf(stats: Awaited<ReturnType<typeof lstat>>): SkillFilesystemEntryKind {
  if (stats.isSymbolicLink()) {
    return 'symlink'
  }
  if (stats.isDirectory()) {
    return 'directory'
  }
  return stats.isFile() ? 'file' : 'other'
}

function isMissing(error: unknown): boolean {
  const code = filesystemErrorCode(error)
  return code === 'ENOENT' || code === 'ENOTDIR'
}

export const nativeBundledSkillFilesystem: BundledSkillFilesystem = {
  supportsLinks: true,
  stat: async (path) => {
    try {
      const stats = await lstat(path)
      return { kind: kindOf(stats), mtimeMs: stats.mtimeMs }
    } catch (error) {
      return isMissing(error) ? { kind: 'missing', mtimeMs: null } : null
    }
  },
  readLink: (path) => readlink(path).catch(() => null),
  realpath: (path) => realpath(path).catch(() => null),
  listEntries: async (directory) => {
    const listing = await nativeSkillInstallFilesystem.listEntries?.([directory]).catch(() => null)
    return listing?.get(directory) ?? null
  },
  readFile: async (path, maxBytes) => {
    if (maxBytes === undefined) {
      return readFile(path).catch(() => null)
    }
    try {
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of createReadStream(path, { end: maxBytes })) {
        if (!Buffer.isBuffer(chunk)) {
          return null
        }
        size += chunk.length
        if (size > maxBytes) {
          return null
        }
        chunks.push(chunk)
      }
      return Buffer.concat(chunks)
    } catch {
      return null
    }
  },
  hashFile: async (path) => {
    try {
      const hash = createHash('sha256')
      for await (const chunk of createReadStream(path)) {
        if (!Buffer.isBuffer(chunk)) {
          return null
        }
        hash.update(chunk)
      }
      return hash.digest('hex')
    } catch {
      return null
    }
  },
  canWrite: async (directory) => {
    for (let current = directory; ; current = dirname(current)) {
      const writable = await access(current, constants.W_OK).then(
        () => true,
        (error: unknown) => (isMissing(error) ? null : false)
      )
      if (writable !== null || dirname(current) === current) {
        return writable ?? false
      }
    }
  },
  writeFolder: async (path, files) => {
    await mkdir(dirname(path), { recursive: true })
    // Cloud staging uses private modes; installed skills must be readable by other agents' users.
    await mkdir(path, { mode: 0o755 })
    for (const file of files) {
      await mkdir(dirname(join(path, file.path)), { recursive: true, mode: 0o755 })
      await writeFile(join(path, file.path), file.text, { mode: 0o644, flag: 'wx' })
    }
  },
  ensureDirectory: async (path) => {
    await mkdir(path, { recursive: true, mode: 0o700 })
    if (process.platform !== 'win32') {
      await chmod(path, 0o700)
    }
  },
  rename: nativeSkillInstallFilesystem.rename,
  moveToBackup: async (source, target) => {
    await moveAcrossFilesystems(nativeBundledSkillFilesystem, source, target)
    if (process.platform !== 'win32' && (await lstat(target)).isDirectory()) {
      await chmod(target, 0o700)
    }
  },
  remove: nativeSkillInstallFilesystem.remove,
  createLink: createNativeSkillAlias
}
