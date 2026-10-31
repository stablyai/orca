import { resolve, relative, isAbsolute, sep } from 'node:path'
import { rm } from 'node:fs/promises'
import { JournalHostDatabase } from './journal-host-database'
import { replayJournal } from './journal-open'
import { serializeJournalRow } from './journal-row-schema'
import {
  iterateJournalEpochRows,
  publishJournalSessionEpoch,
  readJournalSessionEpoch
} from './journal-row-table'
import { AgentSessionJournal } from './journal-store'
import type { AgentSessionJournalOptions } from './journal-store-contracts'
import type { JournalLoad } from './journal-open'
import type { JournalRow } from './journal-row-schema'
import type { JournalStoredRow } from './journal-row-table'
import type Database from '../../sqlite/sync-database'

// Share one connection per test profile to match production host ownership.

const opened = new Map<string, JournalHostDatabase>()

export function openTestJournalHostDatabase(stateDirectory: string): JournalHostDatabase {
  const directory = resolve(stateDirectory)
  const existing = opened.get(directory)
  if (existing && !existing.isClosed) {
    return existing
  }
  const database = JournalHostDatabase.open(directory)
  opened.set(directory, database)
  return database
}

export async function closeTestJournalHostDatabase(stateDirectory: string): Promise<void> {
  const directory = resolve(stateDirectory)
  await opened.get(directory)?.close()
  opened.delete(directory)
}

export async function closeTestJournalHostDatabases(): Promise<void> {
  for (const database of opened.values()) {
    await database.close()
  }
  opened.clear()
}

export type TestJournalOptions = Omit<AgentSessionJournalOptions, 'database'> & {
  stateDirectory: string
  database?: JournalHostDatabase
}

export type TrackedJournalOpener = {
  open: (options: TestJournalOptions) => Promise<AgentSessionJournal>
  track: <T extends AgentSessionJournal>(journal: T) => T
  closeAll: () => Promise<void>
  database: (stateDirectory: string, database?: JournalHostDatabase) => JournalHostDatabase
  ownRoot: (root: string) => string
  dispose: (roots?: readonly string[], blocked?: readonly string[]) => Promise<void>
}

export function createTrackedJournalOpener(options: { scoped?: true } = {}): TrackedJournalOpener {
  if (options.scoped) {
    const profiles = new Map<JournalHostDatabase, Set<AgentSessionJournal>>()
    const completed = new WeakSet<AgentSessionJournal>()
    const directories = new Set<string>()
    const failedProfiles = new Map<JournalHostDatabase, Set<AgentSessionJournal>>()
    const ownRoot = (root: string) => {
      directories.add(root)
      return root
    }
    const retained = new Map<string, unknown[]>()
    const database = (directory: string, supplied?: JournalHostDatabase) => {
      const owner = supplied ?? openTestJournalHostDatabase(directory)
      if (!profiles.has(owner)) {
        profiles.set(owner, new Set())
        const close = owner.close.bind(owner)
        owner.close = async () => {
          try {
            await close()
          } catch (error) {
            const directory = resolve(owner.stateDirectory)
            retained.set(directory, [...(retained.get(directory) ?? []), error])
            failedProfiles.set(owner, profiles.get(owner) ?? new Set())
            throw error
          }
        }
      }
      return owner
    }
    const track = <T extends AgentSessionJournal>(journal: T): T => {
      const owner = database(journal['database'].stateDirectory, journal['database'])
      const users = profiles.get(owner)!
      if (!users.has(journal)) {
        users.add(journal)
        const close = journal.close.bind(journal)
        journal.close = (...args) => {
          const operation = close(...args)
          void operation.then(
            () => completed.add(journal),
            () => {}
          )
          return operation
        }
      }
      return journal
    }
    const closeAll = async () => {
      const owned = [...profiles]
      profiles.clear()
      const failures: unknown[] = []
      for (const [owner, users] of owned) {
        const directory = resolve(owner.stateDirectory)
        const errors: unknown[] = [...(retained.get(directory) ?? [])]
        for (const journal of users) {
          if (completed.has(journal)) {
            continue
          }
          try {
            await journal.close()
          } catch (error) {
            errors.push(error)
          }
        }
        if (errors.length === 0 && !retained.has(directory)) {
          try {
            await owner.close()
            if (opened.get(directory) === owner) {
              opened.delete(directory)
            }
          } catch (error) {
            errors.push(error)
          }
        }
        if (errors.length > 0) {
          failedProfiles.set(owner, users)
          retained.set(directory, [...(retained.get(directory) ?? []), ...errors])
          failures.push(new AggregateError(errors, `journal profile cleanup failed: ${directory}`))
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, 'scoped journals failed to close', {
          cause: failedProfiles
        })
      }
    }
    return {
      database,
      ownRoot,
      track,
      open: async ({ stateDirectory, database: supplied, ...options }) => {
        const owner = database(stateDirectory, supplied)
        const journal = track(new AgentSessionJournal({ ...options, database: owner }))
        await journal.open()
        return journal
      },
      closeAll,
      dispose: async (roots = [...directories], blocked = []) => {
        directories.clear()
        const failures: unknown[] = []
        // Unsafe producer profiles never reach logical/native close.
        for (const [owner] of profiles) {
          if (blocked.some((directory) => resolve(directory) === resolve(owner.stateDirectory))) {
            failedProfiles.set(owner, profiles.get(owner)!)
            profiles.delete(owner)
            retained.set(resolve(owner.stateDirectory), [new Error('producer drain failed')])
          }
        }
        try {
          await closeAll()
        } catch (error) {
          failures.push(error)
        }
        const unsafe = [...retained.keys(), ...blocked.map((root) => resolve(root))]
        for (const root of [...roots].sort((a, b) => b.length - a.length)) {
          const directory = resolve(root)
          const contains = (child: string) => {
            const suffix = relative(directory, child)
            return (
              suffix === '' ||
              (suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix))
            )
          }
          if (unsafe.some(contains)) {
            failures.push(new Error(`retained unsafe journal profile under ${directory}`))
            continue
          }
          try {
            await rm(directory, { recursive: true, force: true })
          } catch (error) {
            unsafe.push(directory)
            failures.push(error)
          }
        }
        if (failures.length > 0) {
          throw new AggregateError(failures, 'scoped journal disposal failed')
        }
      }
    }
  }
  const journals: AgentSessionJournal[] = []
  return {
    database: openTestJournalHostDatabase,
    ownRoot: (root) => root,
    dispose: async () => {
      throw new Error('directory disposal requires scoped journals')
    },
    open: async ({ stateDirectory, ...options }) => {
      const { openAgentSessionJournal } = await import('./journal-store-factory')
      const journal = await openAgentSessionJournal({
        ...options,
        database: openTestJournalHostDatabase(stateDirectory)
      })
      journals.push(journal)
      return journal
    },
    track: (journal) => {
      journals.push(journal)
      return journal
    },
    closeAll: async () => {
      await Promise.allSettled(journals.splice(0).map((journal) => journal.close()))
      await closeTestJournalHostDatabases()
    }
  }
}

export const SAVED_BY_NEWER_ORCA = {
  refusal: {
    code: 'agent_session_journal_unreadable',
    details: { reason: 'journalWrittenByNewerOrca' }
  }
}

export function loadTestJournal(stateDirectory: string, sessionId: string): JournalLoad | null {
  return replayJournal(openTestJournalHostDatabase(stateDirectory).db, sessionId)
}

function liveEpoch(db: Database.Database, sessionId: string): string {
  const epoch = readJournalSessionEpoch(db, sessionId)
  if (epoch === null) {
    throw new Error(`no journal for ${sessionId}`)
  }
  return epoch
}

export function publishTestJournalEpoch(
  db: Database.Database,
  sessionId: string,
  epoch: string
): void {
  publishJournalSessionEpoch(db, { sessionId, workspaceId: 'ws-1' }, epoch)
}

export function readTestJournalRows(
  db: Database.Database,
  sessionId: string,
  epoch: string
): JournalStoredRow[] {
  return readJournalSessionEpoch(db, sessionId) === epoch
    ? [...iterateJournalEpochRows(db, sessionId, epoch)]
    : []
}

export function liveTestJournalRows(db: Database.Database, sessionId: string): JournalStoredRow[] {
  const epoch = readJournalSessionEpoch(db, sessionId)
  return epoch === null ? [] : [...iterateJournalEpochRows(db, sessionId, epoch)]
}

export function insertTestJournalRow(
  db: Database.Database,
  sessionId: string,
  row: JournalRow
): void {
  insertTestJournalRowJson(db, sessionId, row.seq, serializeJournalRow(row), row.ts)
}

export function insertTestJournalRowJson(
  db: Database.Database,
  sessionId: string,
  seq: number,
  rowJson: string,
  ts = 1
): void {
  db.prepare(
    'INSERT INTO journal_rows (session_id, epoch, seq, ts, row_json) VALUES (?, ?, ?, ?, ?)'
  ).run(sessionId, liveEpoch(db, sessionId), seq, ts, rowJson)
}

export function updateTestJournalRowJson(
  db: Database.Database,
  sessionId: string,
  seq: number,
  rowJson: string
): void {
  db.prepare(
    'UPDATE journal_rows SET row_json = ? WHERE session_id = ? AND epoch = ? AND seq = ?'
  ).run(rowJson, sessionId, liveEpoch(db, sessionId), seq)
}

export function deleteTestJournalRow(db: Database.Database, sessionId: string, seq: number): void {
  db.prepare('DELETE FROM journal_rows WHERE session_id = ? AND epoch = ? AND seq = ?').run(
    sessionId,
    liveEpoch(db, sessionId),
    seq
  )
}
