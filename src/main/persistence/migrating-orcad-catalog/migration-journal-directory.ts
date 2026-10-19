/**
 * One durable, owner-only JSON file per migration in a directory beside the profile. Each source
 * kind keeps its own directory, so a build that knows only one kind never reads another's records.
 * Reads fail closed: an entry that cannot be trusted throws instead of being skipped.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { writeSecureJsonFileWithinLimit } from '../../../shared/bounded-secure-json-file'
import { errorMessage } from '../../../shared/error-message'
import { readNodeFileSyncWithinLimit } from '../../../shared/node-bounded-file-reader'
import { syncDirectoryDurablySync } from '../../durable-file-write'

const JOURNAL_FILE = /^[A-Za-z0-9_-]{1,128}\.json$/

export type MigrationJournalDirectory<T extends { migrationId: string }> = {
  directory: (userDataPath: string) => string
  /** Every record; throws (the configured unreadable error) rather than skipping a file. */
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
}): MigrationJournalDirectory<T> {
  // Why: hidden-row checks run on every list call, and each record may embed a full manifest.
  const parsed = new Map<string, { key: string; records: T[] }>()
  const directory = (userDataPath: string): string => join(userDataPath, options.directoryName)
  const fileVersion = (path: string): string => {
    try {
      // Durable writes replace the file, so size, mtime and inode change with every rewrite.
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
      // The write is already durable; a follower failing must not undo or fail it.
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
      const files: { name: string; path: string }[] = []
      for (const name of names) {
        if (!name.endsWith('.json')) {
          continue // Durable-write temporaries and foreign files carry no journal state.
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
      // A new directory's own entry lives in its parent; without this a crash can lose the journal.
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

/**
 * Oldest first: the records of one source as a single chain of delta moves, each naming the
 * migration it extends. Throws `unreadable` when they fork or leave a gap.
 */
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
