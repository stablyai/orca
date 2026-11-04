import type {
  JournalPersistenceEffect,
  JournalEffectResult
} from '../native-chat/agent-session-journal/journal-persistence-plan'
import type {
  SurfaceStorageResult,
  SurfaceStorageMutation
} from '../../shared/workspace-surfaces/surface-storage-command'
import type Database from '../sqlite/sync-database'
import { admitSurfaceNativeJournal } from './surface-native-journal-admission'
import { configureSqliteRollbackDurability } from '../sqlite/rollback-durability'
import { withProfileStateWriteTransaction } from '../persistence/profile-state/profile-state-write-transaction'
import { applySurfaceOwnerCommandsInTransaction } from './surface-owner-command'

export type SurfaceJointTransaction = {
  journalPath: string
  commands: readonly SurfaceStorageMutation[]
  effectCount?: number
}

export type SurfaceJointResult = {
  surfaces: SurfaceStorageResult[]
  values: JournalEffectResult[]
}

/** The shared native lane drains all handles before admitting this profile-owner job. */
export function executeSurfaceJointTransaction(
  db: Database.Database,
  expectedRevision: number,
  transaction: SurfaceJointTransaction,
  effects: readonly JournalPersistenceEffect[] = []
) {
  if (db.isTransaction || !transaction.commands.length) {
    throw new Error('Joint surface transaction requires an idle profile owner and commands')
  }
  if (effects.length !== (transaction.effectCount ?? 0)) {
    throw new Error('Joint journal unit is incomplete')
  }
  admitSurfaceNativeJournal(db, transaction.journalPath)
  db.prepare('ATTACH DATABASE ? AS surface_chat').run(transaction.journalPath)
  try {
    configureSqliteRollbackDurability(db, 'main', 5000)
    configureSqliteRollbackDurability(db, 'surface_chat', 5000)
    return withProfileStateWriteTransaction(db, () => {
      const result = applySurfaceOwnerCommandsInTransaction(
        db,
        expectedRevision,
        transaction.commands,
        undefined,
        undefined,
        true,
        effects
      )
      if (
        effects.length &&
        result.results.some(
          (entry) =>
            entry.outcome &&
            typeof entry.outcome === 'object' &&
            'status' in entry.outcome &&
            entry.outcome.status === 'conflict'
        )
      ) {
        throw new Error('Native surface target changed before commit')
      }
      return result
    })
  } finally {
    // A failed rollback keeps both handles owned for SQLite recovery; never detach through it.
    if (!db.isTransaction) {
      db.exec('DETACH DATABASE surface_chat')
    }
  }
}
