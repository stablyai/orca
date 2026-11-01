import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach } from 'vitest'
import type {
  AgentJournalMessageItem,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import Database from '../../sqlite/sync-database'
import { journalDatabasePath } from './journal-host-database'
import {
  createTrackedJournalOpener,
  liveTestJournalRows,
  readTestJournalOutcomes,
  updateTestJournalRowJson
} from './journal-host-database-test-support'
import { parseJournalRow } from './journal-row-schema'
import { fields } from './journal-state-schema'
import type { AgentSessionJournal } from './journal-store'
import { queuePauseHolding } from './queued-message-pause'
import { claudeProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { agentSessionSendBodyFingerprint } from '../../../shared/structured-agent-session-send-mutation'

export function createFixture() {
  const IDENTITY: AgentSessionJournalIdentity = {
    sessionId: 'session-p',
    workspaceId: 'ws-1',
    hostId: 'host-1',
    agent: 'claude',
    providerHandle: claudeProviderHandle('native-1', null)
  }

  let root: string

  let clock = 1_000

  const journals = createTrackedJournalOpener({ legacyInputs: true })

  function message(text: string): AgentJournalMessageItem {
    return { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] }
  }

  function fingerprintOf(text: string): string {
    return agentSessionSendBodyFingerprint(IDENTITY.sessionId, message(text))
  }

  function open(): Promise<AgentSessionJournal> {
    return journals.open({
      identity: IDENTITY,
      stateDirectory: root,
      now: () => ++clock,
      mintEpoch: () => `epoch-${clock}`
    })
  }

  function queueDraft(journal: AgentSessionJournal, messageId: string) {
    return journal.queuedMessages.insert({ messageId, body: message(messageId) })
  }

  function clearContext(journal: AgentSessionJournal) {
    return journal.context.clear(
      { operationId: `clear-${++clock}`, afterFence: 0, clearedAt: clock },
      { write: () => {}, committed: () => {} }
    )
  }

  async function turn(journal: AgentSessionJournal, id: string, accept = true): Promise<void> {
    await journal.appendSubmission({
      clientMessageId: id,
      payloadFingerprint: `fp-${id}`,
      body: message(id),
      fence: 0,
      handoverRecorded: true
    })
    if (accept) {
      await acceptTurn(journal, id)
    }
  }

  function acceptTurn(journal: AgentSessionJournal, id: string) {
    return journal.resolveDispatch({
      clientMessageId: id,
      state: 'accepted',
      providerIdentity: { provider: 'claude', sessionId: 'native-1', uuid: `echo-${id}` },
      fence: 0
    })
  }

  function userStop(journal: AgentSessionJournal) {
    return journal.appendStopEvent({ reason: 'user-stop' }, 0)
  }

  function reason(journal: AgentSessionJournal): string | null {
    return journal.queuedMessages.pauses()[0]?.reason ?? null
  }

  function held(journal: AgentSessionJournal): [string, boolean][] {
    const pauses = journal.queuedMessages.pauses()
    return journal.queuedMessages
      .list()
      .filter((card) => card.state === 'waiting')
      .map((card) => [card.messageId, queuePauseHolding(pauses, card) !== undefined])
  }

  function stopEvents(): unknown[] {
    const db = new Database(journalDatabasePath(root), { readonly: true })
    try {
      // An outcome epoch (every replaced one) stores the Stop as pause marks, not as an input row.
      const marks = readTestJournalOutcomes(db, IDENTITY.sessionId).filter(
        (value) => value.field === '$' && value.key === JSON.stringify('queuePauseMarks')
      )
      if (marks.length > 0) {
        const stop = fields.queuePauseMarks.parse(JSON.parse(marks.at(-1)!.json)).latestStop
        return stop ? [stop.event] : []
      }
      return liveTestJournalRows(db, IDENTITY.sessionId).flatMap((stored) => {
        const parsed = parseJournalRow(stored.rowJson)
        return parsed.ok && parsed.row.kind === 'tombstone' && parsed.row.stopEvent
          ? [parsed.row.stopEvent]
          : []
      })
    } finally {
      db.close()
    }
  }

  function rewriteRows(keys: Record<number, [string, unknown]>): void {
    const db = new Database(journalDatabasePath(root))
    try {
      for (const stored of liveTestJournalRows(db, IDENTITY.sessionId)) {
        const rewrite = keys[stored.seq]
        if (rewrite) {
          const row: Record<string, unknown> = JSON.parse(stored.rowJson)
          row[rewrite[0]] = rewrite[1]
          updateTestJournalRowJson(db, IDENTITY.sessionId, stored.seq, JSON.stringify(row))
        }
      }
    } finally {
      db.close()
    }
  }

  function pauseTables(): number {
    const db = new Database(journalDatabasePath(root), { readonly: true })
    try {
      return db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%pause%'")
        .all().length
    } finally {
      db.close()
    }
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-queue-pause-'))
    clock = 1_000
  })

  afterEach(async () => {
    await journals.closeAll()
    await rm(root, { recursive: true, force: true })
  })

  return {
    IDENTITY,
    acceptTurn,
    clearContext,
    get clock() {
      return clock
    },
    set clock(value: typeof clock) {
      clock = value
    },
    fingerprintOf,
    held,
    journals,
    message,
    open,
    pauseTables,
    queueDraft,
    reason,
    rewriteRows,
    get root() {
      return root
    },
    set root(value: typeof root) {
      root = value
    },
    stopEvents,
    turn,
    userStop
  }
}
