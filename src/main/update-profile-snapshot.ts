import { randomUUID } from 'node:crypto'
import { copyFile, lstat, mkdir, open, readdir, readlink, realpath, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { writeFileDurable } from './durable-file-write'
import { snapshotUpdateDatabase } from './update-sqlite-snapshot'
import { snapshotFileHash, createPrivateSnapshotDirectory } from './update-snapshot-file'
import { pruneUpdateSnapshots } from './update-snapshot-retention'

export type UpdateSnapshotEntry = { path: string; sha256?: string; link?: string; directory?: true }
export type UpdateSnapshotManifest = {
  format: 1
  version: string
  createdAt: string
  entries: UpdateSnapshotEntry[]
}

// Rebuilt browser caches and process rendezvous files are not durable user state.
const TRANSIENT_ROOTS = new Set([
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'Crashpad',
  'logs',
  'DevToolsActivePort',
  'SingletonLock',
  'SingletonCookie',
  'SingletonSocket',
  '.profile-state-access'
])

async function isSqlite(path: string): Promise<boolean> {
  const file = await open(path, 'r')
  try {
    const header = Buffer.alloc(16)
    await file.read(header, 0, 16, 0)
    return header.toString() === 'SQLite format 3\0'
  } finally {
    await file.close()
  }
}

async function copySnapshotFile(source: string, target: string): Promise<void> {
  if (await isSqlite(source)) {
    await snapshotUpdateDatabase(source, target)
    return
  }
  const before = await lstat(source)
  await copyFile(source, target)
  const after = await lstat(source)
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new Error('A profile file changed during backup; retry before updating')
  }
  const file = await open(target, 'r+')
  try {
    await file.chmod(0o600 | (before.mode & 0o100))
    await file.sync()
  } finally {
    await file.close()
  }
}

/** Each SQLite file uses its online backup API, including committed WAL data. */
export async function createUpdateProfileSnapshot(
  profile: string,
  version: string,
  backupRoot = join(dirname(profile), `${basename(profile)}.update-backups`)
): Promise<string> {
  const source = await realpath(profile)
  const requested = relative(source, resolve(backupRoot))
  if (
    !requested ||
    (!requested.startsWith(`..${sep}`) && requested !== '..' && !isAbsolute(requested))
  ) {
    throw new Error('Backup must be outside the profile')
  }
  await mkdir(backupRoot, { recursive: true, mode: 0o700 })
  const root = await realpath(backupRoot)
  if (root === source || root.startsWith(`${source}${sep}`)) {
    throw new Error('Backup must be outside the profile')
  }
  const destination = join(root, `${Date.now()}-${randomUUID()}`)
  await createPrivateSnapshotDirectory(destination)
  await mkdir(join(destination, 'data'), { recursive: true, mode: 0o700 })
  const entries: UpdateSnapshotEntry[] = []
  const visit = async (directory: string): Promise<void> => {
    const names = await readdir(join(source, directory))
    const levelDb = names.includes('CURRENT') && names.some((name) => name.startsWith('MANIFEST-'))
    const levelDbNames = levelDb ? names.filter((name) => name !== 'LOCK').sort() : []
    const levelDbBefore = await Promise.all(
      levelDbNames.map((name) => snapshotFileHash(join(source, directory, name)))
    )
    for (const name of names) {
      // LevelDB recreates this process lease; it contains no database records.
      if (levelDb && name === 'LOCK') {
        continue
      }
      // Chromium stores persistent browser partitions under Partitions/<name>.
      const browserRoot = !directory || /^Partitions[\\/][^\\/]+$/.test(directory)
      if (browserRoot && TRANSIENT_ROOTS.has(name)) {
        continue
      }
      const path = join(directory, name)
      const input = join(source, path)
      const output = join(destination, 'data', path)
      const info = await lstat(input)
      if (info.isSocket()) {
        continue
      }
      if (info.isSymbolicLink()) {
        entries.push({ path, link: await readlink(input) })
      } else if (info.isDirectory()) {
        entries.push({ path, directory: true })
        await mkdir(output, { recursive: true, mode: 0o700 })
        await visit(path)
      } else if (info.isFile()) {
        const main = input.replace(/-(wal|shm|journal)$/, '')
        if (main !== input && (await isSqlite(main).catch(() => false))) {
          continue
        }
        try {
          await copySnapshotFile(input, output)
        } catch (error) {
          throw new Error(`Update backup could not copy ${path}`, { cause: error })
        }
        entries.push({ path, sha256: await snapshotFileHash(output) })
      } else {
        throw new Error('Profile contains a live special file; stop its owner before updating')
      }
    }
    if (levelDb) {
      const afterNames = (await readdir(join(source, directory)))
        .filter((name) => name !== 'LOCK')
        .sort()
      const after = await Promise.all(
        levelDbNames.map((name) => snapshotFileHash(join(source, directory, name)))
      )
      const copied = await Promise.all(
        levelDbNames.map((name) => snapshotFileHash(join(destination, 'data', directory, name)))
      )
      if (
        JSON.stringify(levelDbNames) !== JSON.stringify(afterNames) ||
        JSON.stringify(levelDbBefore) !== JSON.stringify(after) ||
        JSON.stringify(levelDbBefore) !== JSON.stringify(copied)
      ) {
        throw new Error('Browser storage changed during backup; retry before updating')
      }
    }
  }
  try {
    await visit('')
    const manifest: UpdateSnapshotManifest = {
      format: 1,
      version,
      createdAt: new Date().toISOString(),
      entries
    }
    // A failed copy has no manifest and can never be mistaken for a completed backup.
    await writeFileDurable(
      join(destination, 'manifest.tmp'),
      join(destination, 'manifest.json'),
      JSON.stringify(manifest)
    )
  } catch (error) {
    // Only remove this invocation's private staging directory, never another writer's.
    await rm(destination, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
  await pruneUpdateSnapshots(root, destination)
  return destination
}
