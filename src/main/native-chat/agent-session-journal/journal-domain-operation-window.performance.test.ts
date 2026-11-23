import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import { migrateJournalDomainSchema } from './journal-domain-schema'
import { ensureAgentSessionAttachmentClaimTables } from '../agent-session-attachments/agent-session-attachment-claims'
import { applyJournalDomainSubmission } from './journal-domain-submission-admission'
import { applyJournalDomainDispatch } from './journal-domain-dispatch'
import { applyJournalDomainItem } from './journal-domain-item'
import { readJournalDomainOperationWindow } from './journal-domain-operation-window'
import { JournalSqlScope } from './journal-sql-scope'
import { windowPlaceRows } from './journal-operation-window-sends'
import { codexTurnLifecycleIdentity } from '../../codex/structured/journal/codex-structured-journal-translation-turns'
import { codexProviderHandle } from '../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import { agentSessionSendBodyFingerprint } from '../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'

// #47529: opening one ended turn of a bot group room reads it through the operation window. Guards
// the bounded read: the rows and sends it returns stay fixed however many turns the chat ran after
// it. The tally counts rows returned to our code, not work inside SQLite; each send read is pinned to
// its index and was checked to key on it with EXPLAIN QUERY PLAN in review. Reverting the bound makes
// the count grow with the later turns.

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

const target = { sessionId: 'chat', epoch: 'epoch' }
const facts = {
  identity: {
    sessionId: 'chat',
    workspaceId: 'workspace',
    hostId: 'host',
    agent: 'codex' as const,
    providerHandle: codexProviderHandle('thread')
  }
}

/** A chat of `turns` finished turns, each opened by its own send. */
function chat(
  turns: number,
  linkedAt: (index: number) => boolean = () => true,
  /** This send is handed over and never answered: no dispatch, no turn. */
  unansweredAt?: number,
  /** Sends before this index were recovered in doubt after a crash: unknown, never unanswered. */
  recoveredBelow = 0,
  /** Tool calls the last turn ran, as a long agent turn does. */
  lastTurnTools = 0
): Database {
  const directory = mkdtempSync(join(tmpdir(), 'orca-operation-window-'))
  directories.push(directory)
  const db = new Database(join(directory, 'journal.sqlite'))
  migrateJournalDomainSchema(db)
  ensureAgentSessionAttachmentClaimTables(db)
  db.prepare(`INSERT INTO journal_chat_state(session_id,workspace_id,epoch,last_sequence,highest_fence)
    VALUES('chat','workspace','epoch',0,1)`).run()
  let now = 1_800_000_000_000
  // One commit for the whole chat: per-step commits fsync hundreds of times on Windows.
  const transaction = (run: () => void) => run()
  db.exec('BEGIN IMMEDIATE')
  for (let index = 0; index < turns; index += 1) {
    const linked = linkedAt(index)
    const id = `m${index}`
    const turn = codexTurnLifecycleIdentity('chat', `turn-${index}`)
    const body: AgentJournalMessageItem = {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: `ask ${index}` }]
    }
    transaction(() =>
      applyJournalDomainSubmission(
        db,
        directory,
        target,
        {
          kind: 'submission',
          input: {
            clientMessageId: id,
            body,
            payloadFingerprint: agentSessionSendBodyFingerprint('chat', body),
            fence: 1,
            origin: 'client',
            source: { kind: 'user' },
            handoverRecorded: true,
            // Each send carried a queued card, as agent mail to a member chat does.
            queuedMessageId: `card-${index}`
          }
        },
        facts,
        now++
      )
    )
    if (index === unansweredAt) {
      continue
    }
    transaction(() =>
      applyJournalDomainDispatch(
        db,
        target,
        {
          kind: 'dispatch',
          input:
            index < recoveredBelow
              ? { clientMessageId: id, fence: 1, state: 'unknown', recovered: true }
              : {
                  clientMessageId: id,
                  fence: 1,
                  state: 'accepted',
                  providerIdentity: {
                    provider: 'codex',
                    threadId: 'thread',
                    turnId: 'echo',
                    ordinal: index
                  },
                  ...(linked ? { answeredInTurn: { turn, via: 'start' as const } } : {})
                }
        },
        now++
      )
    )
    transaction(() =>
      applyJournalDomainItem(
        db,
        target,
        {
          kind: 'item',
          identity: turn,
          body: {
            kind: 'turn',
            turnId: `turn-${index}`,
            state: 'completed',
            outcome: 'success',
            ...(linked ? { userItemId: agentJournalSubmissionKey(id) } : {})
          },
          options: { turnScope: { kind: 'thread' }, fence: 1 }
        },
        now++
      )
    )
  }
  for (let call = 0; call < lastTurnTools; call += 1) {
    applyJournalDomainItem(
      db,
      target,
      {
        kind: 'item',
        identity: { provider: 'orca', clientMessageId: `call-${call}` },
        body: {
          kind: 'tool-call',
          name: 'shell',
          callId: `call-${call}`,
          input: {},
          state: 'completed'
        },
        options: { turnScope: { kind: 'thread' }, fence: 1 }
      },
      now++
    )
  }
  db.exec('COMMIT')
  return db
}

function openFirstTurn(db: Database, ...operationIds: string[]) {
  const scope = new JournalSqlScope(db, 'chat', 'epoch')
  const { snapshot } = readJournalDomainOperationWindow(scope, {
    operationIds,
    anchorsOnly: true,
    throughAnchoredTurns: true
  })
  // The whole-chat read of the same operation, for the rows of its own turn.
  const whole = readJournalDomainOperationWindow(new JournalSqlScope(db, 'chat', 'epoch'), {
    operationIds
  }).snapshot
  return { snapshot, whole, examined: scope.work.rows }
}

const turnZero = (items: readonly { itemId: string; sequence: number }[], end: number) =>
  items.filter((item) => item.sequence < end).map((item) => item.itemId)

it('opens one old turn with the same work however many turns followed it', () => {
  for (const turns of [10, 100]) {
    const db = chat(turns)
    for (const operationId of ['m0', 'card-0']) {
      const { snapshot, whole, examined } = openFirstTurn(db, operationId)
      expect(examined).toBe(16)
      // Its own send, and the next turn's, whose prompt sits just before where that turn opens.
      expect(snapshot.submissions.map((send) => send.clientMessageId)).toEqual(['m0', 'm1'])
      const turnIds = snapshot.items.flatMap((item) =>
        item.body.kind === 'turn' ? [item.body.turnId] : []
      )
      expect(turnIds).toEqual(['turn-0'])
      // The same rows the whole-chat read holds up to where the next turn opens.
      const end = Math.max(...snapshot.items.map((item) => item.sequence)) + 1
      expect(turnZero(snapshot.items, end)).toEqual(turnZero(whole.items, end))
    }
    db.close()
  }
})

// An older import's turn names no send, and no send names it: it is placed by position.
it('keeps a turn its send is placed in by position alone', () => {
  const db = chat(10, () => false)
  const { snapshot } = openFirstTurn(db, 'm0')
  db.close()
  const turnIds = snapshot.items.flatMap((item) =>
    item.body.kind === 'turn' ? [item.body.turnId] : []
  )
  expect(turnIds).toContain('turn-0')
})

it('keeps every anchored turn when one send names its turn and another is placed by position', () => {
  const db = chat(10, (index) => index !== 5)
  const { snapshot } = openFirstTurn(db, 'm0', 'm5')
  db.close()
  const turnIds = snapshot.items.flatMap((item) =>
    item.body.kind === 'turn' ? [item.body.turnId] : []
  )
  expect(turnIds).toEqual(expect.arrayContaining(['turn-0', 'turn-5']))
})

// Whom a bot's newest turn acts for is read from a window of its newest turns, on every bot request,
// Slack post and item add. Guards that read: its work stays fixed however long the chat ran before.
it('reads the newest turns with the same work however many turns came before them', () => {
  const read = (turns: number, recovered = 0) => {
    const db = chat(turns, () => true, undefined, recovered)
    const scope = new JournalSqlScope(db, 'chat', 'epoch')
    const { snapshot } = readJournalDomainOperationWindow(scope, {
      latestTurns: 8,
      turnShape: true
    })
    db.close()
    return {
      examined: scope.work.rows,
      sends: snapshot.submissions.map((send) => send.clientMessageId),
      turns: snapshot.items.flatMap((item) => (item.body.kind === 'turn' ? [item.body.turnId] : []))
    }
  }
  const short = read(50)
  const long = read(500)
  expect(long.examined).toBe(short.examined)
  expect(long.sends).toEqual(Array.from({ length: 9 }, (_, index) => `m${491 + index}`))
  expect(long.turns).toEqual(Array.from({ length: 9 }, (_, index) => `turn-${491 + index}`))
  // A long agent turn's tool calls are never listed to find its sends, and change nothing it reads.
  const listed = (tools: number) => {
    const db = chat(50, () => true, undefined, 0, tools)
    const ids = db
      .prepare(`SELECT COUNT(*) AS n FROM ${windowPlaceRows('item_id')}`)
      .get('chat', 'epoch', 0, Number.MAX_SAFE_INTEGER)?.n
    const { snapshot } = readJournalDomainOperationWindow(
      new JournalSqlScope(db, 'chat', 'epoch'),
      {
        latestTurns: 8,
        turnShape: true
      }
    )
    db.close()
    return { ids, sends: snapshot.submissions.map((send) => send.clientMessageId) }
  }
  expect(listed(1000)).toEqual(listed(0))
  // Sends recovered in doubt long ago are settled for attribution: they add no work as they pile up.
  expect(read(500, 491).examined).toBe(read(50, 41).examined)
  // A send still unanswered anywhere is the turn still to be attributed: kept, as the whole read does,
  // and with the window pinned back to it the read costs no more than that whole read.
  const db = chat(500, () => true, 0)
  const pinned = new JournalSqlScope(db, 'chat', 'epoch')
  const { snapshot } = readJournalDomainOperationWindow(pinned, { latestTurns: 8, turnShape: true })
  const whole = new JournalSqlScope(db, 'chat', 'epoch')
  readJournalDomainOperationWindow(whole, { latestTurns: 8, turnShape: true, afterSequence: -1 })
  db.close()
  expect(snapshot.submissions.map((send) => send.clientMessageId)).toContain('m0')
  // Plus the unanswered send's own read (it and its queued card), which found it.
  expect(pinned.work.rows).toBeLessThanOrEqual(whole.work.rows + 2)
})
