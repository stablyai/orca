import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { ensureAgentSessionAttachmentClaimTables } from '../agent-session-attachments/agent-session-attachment-claims'
import type { StructuredAgentSessionEventSink } from '../agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import { structuredAgentSessionJournalAppendOptions } from '../agent-session-wire/journal-ingress/structured-agent-session-journal-append-options'
import Database from '../../sqlite/sync-database'
import type { JournalStopEvent } from './durable-rows/journal-row-schema'
import { applyJournalDomainControlCommand } from './journal-domain-control-command'
import { migrateJournalDomainSchema } from './journal-domain-schema'
import { runJournalSqlSteps } from './journal-sql-steps'
import { readJournalStoredItem } from './journal-stored-output-rows'
import type { JournalStepOutcome, JournalWriterStep } from './writing/journal-writer-step'

// A chat's real journal and its real writer: each write a provider sink admits runs as the SQL
// writer's steps, at the time of the fake clock, against the Stop the journal saved. `deferred`:
// writes wait for `drain()`, as the writer's queue resolves them after the producer moves on.
// `rejecting`: the writer's queue refuses every resolved write, as under backpressure.

export const target = { sessionId: 'chat-1', epoch: 'e' }
const FENCE = 1
const ROOM = 1_000_000

export function openStopJournal(options: { deferred?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'orca-stop-writer-'))
  const db = new Database(join(dir, 'journal.db'))
  migrateJournalDomainSchema(db)
  ensureAgentSessionAttachmentClaimTables(db)
  db.prepare(
    `INSERT INTO journal_chat_state(workspace_id,session_id,epoch,last_sequence,highest_fence)
     VALUES('workspace','chat-1','e',10,1)`
  ).run()
  const queued: (() => void)[] = []
  let rejecting = false
  const write = (
    steps: JournalWriterStep[],
    onResolved?: (outcomes: JournalStepOutcome[]) => void
  ) => {
    const run = () => {
      db.exec('BEGIN IMMEDIATE')
      const result = runJournalSqlSteps(
        db,
        { target: { ...target, ownerToken: 'owner' }, operation: { kind: 'steps', steps } },
        Date.now()
      )
      db.exec('COMMIT')
      if (result.value.failure) {
        throw new Error(`journal step failed: ${JSON.stringify(result.value.failure)}`)
      }
      onResolved?.(result.value.outcomes)
    }
    if (options.deferred) {
      queued.push(run)
    } else {
      run()
    }
    return { accepted: true } as const
  }
  const resolved = (
    reservedBytes: number,
    resolution: Extract<JournalWriterStep, { kind: 'resolved-item' }>['resolution'],
    options: Parameters<typeof structuredAgentSessionJournalAppendOptions>[1],
    onOutcome?: (outcome: JournalStepOutcome) => void
  ) =>
    rejecting
      ? ({ accepted: false, reason: 'backpressure' } as const)
      : write(
          [
            {
              kind: 'resolved-item',
              reservedBytes,
              resolution,
              options: structuredAgentSessionJournalAppendOptions(FENCE, options)
            }
          ],
          (outcomes) => {
            if (outcomes[0]) {
              onOutcome?.(outcomes[0])
            }
          }
        )
  const item: StructuredAgentSessionEventSink['appendItem'] = (identity, body, options) => {
    write([
      {
        kind: 'item',
        reservedBytes: ROOM,
        identity,
        body,
        options: structuredAgentSessionJournalAppendOptions(FENCE, options)
      }
    ])
  }
  const sink: StructuredAgentSessionEventSink = {
    appendItem: item,
    tryAppendItem: (identity, body, options) => {
      item(identity, body, options)
      return { accepted: true }
    },
    tryReviseResolvedItem: resolved,
    tryReviseResolvedItemAndPublish: resolved,
    appendTombstone: () => {},
    publish: () => {},
    tryPublish: () => ({ accepted: true })
  }
  return {
    db,
    sink,
    reject: (on: boolean) => {
      rejecting = on
    },
    /** Runs the writes a deferred writer still holds, oldest first, and any they queue. */
    drain: () => {
      for (let next = queued.shift(); next; next = queued.shift()) {
        next()
      }
    },
    stop: (reason: JournalStopEvent['reason'], at: number, turnId: string) => {
      db.exec('BEGIN IMMEDIATE')
      applyJournalDomainControlCommand(
        db,
        target,
        { kind: 'stop-accept', event: { reason }, fence: FENCE, liveTurnId: turnId },
        {},
        at
      )
      db.exec('COMMIT')
    },
    /** The chat's rows as the journal holds them. */
    items: (): AgentJournalRenderItem[] =>
      db
        .prepare(
          `SELECT payload_json FROM journal_items WHERE session_id=? AND epoch=? AND hidden=0
           ORDER BY sequence, ordinal`
        )
        .all(target.sessionId, target.epoch)
        .map((row) =>
          readJournalStoredItem(db, [target.sessionId, target.epoch], row.payload_json)
        ),
    close: () => {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

/** Error rows the chat shows: a status row that reports a failure or is drawn as an error. */
export const errorRows = (items: readonly AgentJournalRenderItem[]) =>
  items.filter(
    (item) =>
      item.body.kind === 'status' && (item.body.failure !== undefined || item.body.tone === 'error')
  )
