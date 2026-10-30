// Unreadable journals fail closed; source-specific directories preserve older-build compatibility.
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { writeSecureJsonFileWithinLimit } from '../../../shared/bounded-secure-json-file'
import { errorMessage } from '../../../shared/error-message'
import { readNodeFileSyncWithinLimit } from '../../../shared/node-bounded-file-reader'
import { syncDirectoryDurablySync } from '../../durable-file-write'

const JOURNAL_FILE = /^[A-Za-z0-9_-]{1,128}\.json$/
// `<id>.json.<pid>.<ms>.<rand>.tmp`: a durable write that died before its rename.
const JOURNAL_TEMPORARY = /^[A-Za-z0-9_-]{1,128}\.json\.(\d+)\.\d+\.[0-9a-f]+\.tmp$/
// Spares a write another instance may still be finishing.
const TEMPORARY_SWEEP_MIN_AGE_MS = 60_000

export type MigrationJournalDirectory<T extends { migrationId: string }> = {
  directory: (userDataPath: string) => string
  /** Throws rather than skipping an unreadable record. */
  list: (userDataPath: string) => T[]
  /** Durable before it returns. */
  write: (userDataPath: string, record: T) => void
  remove: (userDataPath: string, migrationId: string) => void
}

export function createMigrationJournalDirectory<T extends { migrationId: string }>(options: {
  directoryName: string
  maxFileBytes: number
  parse: (value: unknown) => T
  unreadable: (detail: string) => Error
  onChange?: (userDataPath: string) => void
  /** Remove other processes' writes that died before their rename (the WSL move journal only). */
  sweepOrphanedTemporaries?: boolean
}): MigrationJournalDirectory<T> {
  // Frequent hidden-row checks would otherwise reparse full manifests.
  const parsed = new Map<string, { key: string; records: T[] }>()
  const swept = new Set<string>()
  const directory = (userDataPath: string): string => join(userDataPath, options.directoryName)
  const fileVersion = (path: string): string => {
    try {
      // Atomic replacement invalidates cached versions.
      const stat = statSync(path, { bigint: true })
      return `${stat.ino}:${stat.size}:${stat.mtimeNs}`
    } catch (error) {
      throw options.unreadable(errorMessage(error))
    }
  }
  const readFile = (path: string, migrationId: string): T => {
    try {
      const raw = readNodeFileSyncWithinLimit(path, options.maxFileBytes).buffer.toString('utf8')
      const record = options.parse(JSON.parse(raw))
      if (record.migrationId !== migrationId) {
        throw new Error('file name does not match its migration id')
      }
      return record
    } catch (error) {
      throw options.unreadable(errorMessage(error))
    }
  }
  const changed = (userDataPath: string): void => {
    try {
      options.onChange?.(userDataPath)
    } catch (error) {
      // Observer failures cannot invalidate an already-durable write.
      console.warn('[orcad-migration] Journal change follower failed:', error)
    }
  }
  return {
    directory,
    list: (userDataPath) => {
      const dir = directory(userDataPath)
      if (!existsSync(dir)) {
        return []
      }
      let names: string[]
      try {
        names = readdirSync(dir)
      } catch (error) {
        throw options.unreadable(errorMessage(error))
      }
      if (options.sweepOrphanedTemporaries && !swept.has(dir)) {
        swept.add(dir)
        removeOrphanedTemporaries(dir, names)
      }
      const files: { name: string; path: string }[] = []
      for (const name of names) {
        if (!name.endsWith('.json')) {
          continue // Ignore durable-write temporaries and foreign files.
        }
        if (!JOURNAL_FILE.test(name)) {
          throw options.unreadable(`unexpected entry ${name}`)
        }
        files.push({ name, path: join(dir, name) })
      }
      const key = files.map((file) => `${file.name}:${fileVersion(file.path)}`).join('|')
      const cached = parsed.get(dir)
      if (cached?.key === key) {
        return [...cached.records]
      }
      const records = files.map((file) => readFile(file.path, file.name.slice(0, -'.json'.length)))
      parsed.set(dir, { key, records })
      return [...records]
    },
    write: (userDataPath, record) => {
      const valid = options.parse(record)
      if (!JOURNAL_FILE.test(`${valid.migrationId}.json`)) {
        throw new Error('orcad_migration_cutover_id_invalid')
      }
      const dir = directory(userDataPath)
      const created = !existsSync(dir)
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      writeSecureJsonFileWithinLimit(
        join(dir, `${valid.migrationId}.json`),
        valid,
        options.maxFileBytes,
        { durable: true }
      )
      syncDirectoryDurablySync(dir)
      // Fsync the parent too or a crash can lose the newly created directory.
      if (created) {
        syncDirectoryDurablySync(userDataPath)
      }
      parsed.delete(dir)
      changed(userDataPath)
    },
    remove: (userDataPath, migrationId) => {
      if (!JOURNAL_FILE.test(`${migrationId}.json`)) {
        throw new Error('orcad_migration_cutover_id_invalid')
      }
      const dir = directory(userDataPath)
      rmSync(join(dir, `${migrationId}.json`), { force: true })
      parsed.delete(dir)
      if (existsSync(dir)) {
        syncDirectoryDurablySync(dir)
      }
      changed(userDataPath)
    }
  }
}

/** Once per directory and process: another process's write that never reached its rename. */
function removeOrphanedTemporaries(dir: string, names: readonly string[]): void {
  for (const name of names) {
    const pid = JOURNAL_TEMPORARY.exec(name)?.[1]
    if (!pid || Number(pid) === process.pid) {
      continue
    }
    const path = join(dir, name)
    try {
      if (Date.now() - statSync(path).mtimeMs >= TEMPORARY_SWEEP_MIN_AGE_MS) {
        rmSync(path, { force: true })
      }
    } catch {
      // Gone already, or unreadable; it carries no journal state either way.
    }
  }
}

/** Oldest-first delta chain; forks or gaps fail closed. */
export function orderMigrationJournalChain<
  T extends { migrationId: string; supersedesMigrationId?: string }
>(matches: readonly T[], unreadable: (detail: string) => Error, label: string): T[] {
  const superseded = new Set(matches.map((entry) => entry.supersedesMigrationId))
  const heads = matches.filter((entry) => !superseded.has(entry.migrationId))
  if (heads.length > 1) {
    throw unreadable(`${heads.length} journals name ${label}`)
  }
  const byId = new Map(matches.map((entry) => [entry.migrationId, entry]))
  const chain: T[] = []
  let entry: T | undefined = heads[0]
  while (entry && chain.length <= matches.length) {
    chain.unshift(entry)
    entry = entry.supersedesMigrationId ? byId.get(entry.supersedesMigrationId) : undefined
  }
  if (chain.length !== matches.length) {
    throw unreadable(`the journals naming ${label} do not form one chain`)
  }
  return chain
}
