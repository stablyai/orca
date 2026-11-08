import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect } from 'vitest'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import { codexProviderHandle } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import Database from '../../sqlite/sync-database'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from './store-lifecycle/journal-host-database-test-support'
import { seedJournalSqlCommands } from './journal-sql-command.test-fixture'
import {
  createJournalStoreCollaborators,
  type JournalStoreCollaborators
} from './store-lifecycle/journal-store-collaborators'
import type { JournalHostDatabase } from './database/journal-host-database'
import { JournalWriteQueue } from './writing/journal-write-queue'
import { prepareJournalOutcomeWrite } from './outcomes/journal-outcome-write'
import { persistJournalOutcomeRows } from './outcomes/journal-outcome-table'
import {
  ensureJournalOutcomeTables,
  startJournalOutcomeLog
} from './outcomes/journal-outcome-format'
import { createJournalReducerState } from './projection/journal-reducer'
import { journalInputOrder } from './input-order/journal-input-order'
import {
  journalContextCursor,
  physicalJournalCursor
} from './context-epochs/journal-context-cursor'
import type { JournalRecoveryJournal } from './submissions/journal-pending-submission-recovery'
import { journalSqlLifecycleRows } from './journal-sql-reducer-rows.test-fixture'
import { createJournalTablesSql } from './database/journal-database-schema'
import { JournalSqlCommand } from './journal-sql-command'
import { JournalSqlBatch } from './journal-sql-batch'
import type { JournalWriterCommand, JournalWriterOperation } from './journal-writer-command'
import type { JournalWriterHostFacts } from './journal-writer-host-facts'
import { journalSqlFailure, restoreJournalSqlFailure } from './journal-sql-failure'

export const identity: AgentSessionJournalIdentity = {
  sessionId: 'session',
  workspaceId: 'workspace',
  hostId: 'host',
  agent: 'codex',
  providerHandle: codexProviderHandle('thread')
}
export const target = { sessionId: 'session', epoch: 'epoch', ownerToken: 'open-token' }
export const NOW = 1_000
export const text = (value: string): AgentJournalMessageItem => ({
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: value }]
})

let roots: string[] = []
beforeEach(() => {
  roots = []
})
afterEach(async () => {
  await closeTestJournalHostDatabases()
  for (const root of roots) {
    await rm(root, { recursive: true, force: true })
  }
})

/** Today's collaborators over an in-memory fold of the same seeded rows (no actual open on either side). */
export function memoryJournal(database: JournalHostDatabase) {
  const scratch = new Database(':memory:')
  scratch.exec(createJournalTablesSql())
  ensureJournalOutcomeTables(scratch)
  const source = startJournalOutcomeLog(scratch, 'session', 'epoch', 0, 100)
  let state = persistJournalOutcomeRows(
    scratch,
    createJournalReducerState('session', 'epoch'),
    source,
    [journalSqlLifecycleRows()[0]!],
    100,
    true,
    (next) => journalInputOrder(next).cards.ensure(next)
  ).adopt()
  scratch.close()
  const collaborators: JournalStoreCollaborators = createJournalStoreCollaborators({
    notifyCommitted: () => undefined,
    identity,
    now: () => NOW,
    mintEpoch: () => 'minted',
    serialize: (run) => queue.serialize(run),
    database: () => database,
    state: () => state,
    readOnly: () => false,
    cursor: () => journalContextCursor(state),
    adopt: (loaded) => {
      state = loaded.state
    },
    prepare: (db, rows, savedAt, finishFold) => {
      collaborators.queuedMessages.inputState()
      const transition = prepareJournalOutcomeWrite(db, state, rows, savedAt, finishFold)
      return () => {
        state = transition.adopt()
      }
    },
    commit: () => undefined,
    journal: () => ({
      reopenFloor: () => null,
      appendItem: (...args) => collaborators.itemAppender.append(...args)
    }),
    enqueue: (build, receipt) => collaborators.rowWriter.enqueue(build, receipt)
  })
  const queue = new JournalWriteQueue('session')
  const recovery: JournalRecoveryJournal = {
    get inputOrder() {
      return journalInputOrder(state)
    },
    resolveDispatch: (...args) => collaborators.submissionWriter.resolveDispatch(...args),
    queuedMessages: collaborators.queuedMessages,
    physicalCursor: () => physicalJournalCursor(state),
    itemBody: (itemId) => state.items.get(itemId)?.body ?? null
  }
  return Object.assign(collaborators, {
    recovery,
    cursor: () => journalContextCursor(state),
    state: () => state
  })
}

export async function sides() {
  const memoryRoot = await mkdtemp(join(tmpdir(), 'orca-sql-input-memory-'))
  const sqlRoot = await mkdtemp(join(tmpdir(), 'orca-sql-input-writer-'))
  roots.push(memoryRoot, sqlRoot)
  const memoryDatabase = openTestJournalHostDatabase(memoryRoot)
  seedJournalSqlCommands(memoryDatabase.db)
  const memory = memoryJournal(memoryDatabase)
  const sqlDatabase = openTestJournalHostDatabase(sqlRoot)
  seedJournalSqlCommands(sqlDatabase.db)
  const engine = new JournalSqlCommand(sqlDatabase.db, sqlRoot)
  const batch = new JournalSqlBatch(sqlDatabase.db)
  const run = async (
    operation: JournalWriterOperation,
    facts: Partial<JournalWriterHostFacts> = {}
  ) => {
    const command: JournalWriterCommand = {
      target,
      operation,
      facts: { identity, ...facts },
      savedAt: NOW
    }
    const [outcome] = (
      await batch.run([{ command, normal: false }], (entry) => engine.apply(entry, NOW))
    ).outcomes
    if (!outcome!.committed) {
      // Exactly what reaches the host through the worker port.
      throw restoreJournalSqlFailure(journalSqlFailure(outcome!.error))
    }
    return outcome!.value
  }
  return { memory, memoryDb: memoryDatabase.db, sqlDb: sqlDatabase.db, run }
}

export const saved = (db: Database.Database) => ({
  rows: db.prepare('SELECT seq, row_json FROM journal_rows ORDER BY seq').all(),
  outcomes: db
    .prepare(`SELECT seq, field, entry_key, format, ordinal, value_json, deleted
      FROM journal_outcomes ORDER BY seq, field, entry_key`)
    .all()
})

export async function both<T>(
  side: Awaited<ReturnType<typeof sides>>,
  memory: (journal: ReturnType<typeof memoryJournal>) => Promise<T>,
  operation: JournalWriterOperation,
  facts?: Partial<JournalWriterHostFacts>
) {
  const expected = await memory(side.memory).then(
    (value) => ({ value }),
    (error: unknown) => ({ error })
  )
  const actual = await side.run(operation, facts).then(
    (commit) => ({ value: commit.value }),
    (error: unknown) => ({ error })
  )
  if ('error' in expected) {
    expect(actual).toMatchObject({ error: expect.any(Error) })
    const name = (result: { error: unknown } | { value: unknown }) =>
      'error' in result && result.error instanceof Error ? result.error.name : undefined
    expect(name(actual)).toBe(name(expected))
  } else {
    expect(actual).toEqual(expected)
  }
  expect(saved(side.sqlDb)).toEqual(saved(side.memoryDb))
  return actual
}
