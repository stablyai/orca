import type Database from '../../sqlite/sync-database'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { JournalWriterCommand } from './journal-writer-command'
import type { JournalWriterCommit } from './journal-writer-changes'
import { applyJournalWriterEffect, type JournalWriterEffectResult } from './journal-writer-effects'
import { JournalWriterSession } from './journal-writer-session'
import { runJournalWriterOperation } from './journal-writer-operations'
import { planJournalWriterRows } from './journal-writer-plan'
import type { JournalOperationReceipt } from './writing/journal-row-writer'
import { runJournalSqlSteps } from './journal-sql-steps'
import { isJournalStreamedTextRevision } from './writing/journal-streamed-text-revision'
import {
  claimJournalSqlProjection,
  journalLogNeedsFounding,
  recordJournalSqlWatermark
} from './journal-sql-meta'

export class JournalSqlCommand {
  constructor(
    private readonly db: Database.Database,
    private readonly stateDirectory: string
  ) {}

  /** Conservative preflight only; all authority and revision assignment are repeated in apply(). */
  streamed(command: JournalWriterCommand): boolean {
    if (command.effects || command.operation.kind !== 'item') {
      return false
    }
    try {
      const { state } = this.session(command, 0)
      const row = planJournalWriterRows(state, command.operation)[0]!(state.lastSequence + 1, 0)
      return isJournalStreamedTextRevision(state, row)
    } catch {
      // A stale/invalid command fails its own SAVEPOINT; it must not downgrade the batch.
      return false
    }
  }

  async apply(command: JournalWriterCommand, savedAt: number): Promise<JournalWriterCommit> {
    if (!this.db.isTransaction) {
      throw new Error('journal SQL command requires its transaction')
    }
    if (command.operation.kind === 'steps') {
      const commit = await runJournalSqlSteps(
        this.db,
        { ...command, operation: command.operation },
        command.facts ?? { identity: unidentified(command.target.sessionId) },
        (facts) => this.session({ ...command, facts }, command.savedAt ?? savedAt)
      )
      recordJournalSqlWatermark(this.db, command.target.sessionId)
      return commit
    }
    if (
      command.operation.kind === 'open' &&
      !journalLogNeedsFounding(this.db, command.target.sessionId)
    ) {
      claimJournalSqlProjection(this.db, command.target)
    }
    const session = this.session(command, command.savedAt ?? savedAt)
    const effects: JournalWriterEffectResult[] = []
    let receiptWritten = false
    // A present (even empty) effect list is a receipt: operations branch on having one.
    const receipt: JournalOperationReceipt | undefined = command.effects
      ? {
          write: (db) => {
            receiptWritten = true
            const rows = session.projected(session.lastRows)
            for (const effect of command.effects!) {
              effects.push(applyJournalWriterEffect(db, this.stateDirectory, effect, rows))
            }
          },
          committed: () => undefined
        }
      : undefined
    const value = await runJournalWriterOperation(session, command.operation, receipt)
    const { rows: _rows, goals, ...commit } = await session.finish()
    recordJournalSqlWatermark(this.db, command.target.sessionId)
    return {
      ...commit,
      effects,
      ...(receiptWritten ? { receiptWritten: true as const } : {}),
      ...(value === undefined ? {} : { value: plainAnswer(value) }),
      ...(command.facts?.goals ? { goals } : {})
    }
  }

  private session(command: JournalWriterCommand, savedAt: number): JournalWriterSession {
    return new JournalWriterSession(
      this.db,
      this.stateDirectory,
      command.target,
      command.facts ?? { identity: unidentified(command.target.sessionId) },
      savedAt
    )
  }
}

/** Core row commands never read the provider identity; reading it is a protocol bug. */
function unidentified(sessionId: string): AgentSessionJournalIdentity {
  const missing = (): never => {
    throw new Error('journal SQL command omitted its identity facts')
  }
  return {
    sessionId,
    get workspaceId() {
      return missing()
    },
    get hostId() {
      return missing()
    },
    get agent() {
      return missing()
    },
    get providerHandle() {
      return missing()
    }
  }
}

/** Answers leave the worker by structured clone, which refuses the command's tracked proxies. */
function plainAnswer(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) {
    return value
  }
  if (Array.isArray(value)) {
    return value.map(plainAnswer)
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    return value
  }
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, plainAnswer(child)]))
}
