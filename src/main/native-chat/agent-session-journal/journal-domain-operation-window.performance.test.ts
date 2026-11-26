import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import Database from '../../sqlite/sync-database'
import { migrateJournalDomainSchema } from './journal-domain-schema'
import { ensureAgentSessionAttachmentClaimTables } from '../agent-session-attachments/agent-session-attachment-claims'
import { applyJournalDomainSubmission } from './journal-domain-submission-admission'
import { applyJournalDomainDispatch } from './journal-domain-dispatch'
import { applyJournalDomainItem } from './journal-domain-item'
import { readJournalDomainOperationWindow } from './journal-domain-operation-window'
import { JournalWindowNotIndexed } from './journal-operation-window-sends'
import { JournalSqlScope } from './journal-sql-scope'
import { runJournalSqlSteps } from './journal-sql-steps'
import { keptSends } from './journal-operation-window-held-sends'
import { marginBefore } from './journal-operation-window-turn-ahead'
import type { Send } from './journal-operation-window-sends'
import { codexTurnLifecycleIdentity } from '../../codex/structured/journal/codex-structured-journal-translation-turns'
import { codexProviderHandle } from '../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import { agentSessionSendBodyFingerprint } from '../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'

import { botChatReads } from '../../bots/bot-chat-reads'
import type * as ChatSession from '../../bots/bot-chat-session'
import { recoverBotGroupReplies } from '../../bots/bot-group-completed-replies'
import { BotGroupStore } from '../../bots/bot-group-store'
import type { BotGroupTurn } from '../../../shared/bots/bot-group'

const live = vi.hoisted(
  (): {
    operationWindow?: (
      anchors: Parameters<typeof readJournalDomainOperationWindow>[1]
    ) => Promise<ReturnType<typeof readJournalDomainOperationWindow>>
  } => ({})
)
vi.mock('../../bots/bot-chat-session', async (original) => ({
  ...(await original<typeof ChatSession>()),
  requireStructuredHost: async () => ({
    journalReads: async () => ({ operationWindow: live.operationWindow })
  })
}))

// #47529: opening one ended turn of a bot group room reads it through the operation window. Guards
// the bounded read: the rows and sends it returns stay fixed however many turns the chat ran after
// it. The tally counts rows returned to our code, not work inside SQLite; each send read is pinned to
// its index and was checked to key on it with EXPLAIN QUERY PLAN in review. Reverting the bound makes
// the count grow with the later turns. #47789's look-back contract counts work inside SQLite instead,
// through a function wrapped around the rows it tests.

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
  lastTurnTools = 0,
  /** Messages the last turn wrote, as a long agent turn does. */
  lastTurnMessages = 0,
  /** Every send in one family: a chain (each shares a provider id with one neighbour and a card with
   *  the other), one queued card they all carry, or one answering turn they all name (the newest).
   *  Or `unsettled`: every send before the newest ten handed over, and never known answered. */
  family?: 'chain' | 'card' | 'answered' | 'unsettled',
  withGroupReplies = false
): Database {
  const chained = family === 'chain'
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
    const providerIdentity = {
      provider: 'codex' as const,
      threadId: 'thread',
      turnId: 'echo',
      ordinal: chained ? Math.floor((index + 1) / 2) : index
    }
    const providerOpener = withGroupReplies && index === 0
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
            queuedMessageId:
              family === 'card'
                ? 'card'
                : chained
                  ? `card-${Math.floor(index / 2)}`
                  : `card-${index}`
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
            index < recoveredBelow || (family === 'unsettled' && index < turns - 10)
              ? {
                  clientMessageId: id,
                  fence: 1,
                  state: 'unknown',
                  ...(index < recoveredBelow ? { recovered: true as const } : {})
                }
              : {
                  clientMessageId: id,
                  fence: 1,
                  state: 'accepted',
                  providerIdentity,
                  ...(linked && !providerOpener
                    ? {
                        answeredInTurn: {
                          turn:
                            family === 'answered'
                              ? codexTurnLifecycleIdentity('chat', `turn-${turns - 1}`)
                              : turn,
                          via: 'start' as const
                        }
                      }
                    : {})
                }
        },
        now++
      )
    )
    if (withGroupReplies && index === 0) {
      const clientMessageId = 'follow-up'
      applyJournalDomainSubmission(
        db,
        directory,
        target,
        {
          kind: 'submission',
          input: {
            clientMessageId,
            body,
            payloadFingerprint: agentSessionSendBodyFingerprint('chat', body),
            fence: 1,
            origin: 'client',
            source: { kind: 'agent' },
            handoverRecorded: true,
            queuedMessageId: 'follow-up-card'
          }
        },
        facts,
        now++
      )
      applyJournalDomainDispatch(
        db,
        target,
        {
          kind: 'dispatch',
          input: {
            state: 'accepted',
            clientMessageId,
            fence: 1,
            answeredInTurn: { turn, via: 'steer' },
            providerIdentity: {
              provider: 'codex',
              threadId: 'thread',
              turnId: 'turn-0',
              ordinal: 1
            }
          }
        },
        now++
      )
    }
    if (withGroupReplies && index < 2) {
      applyJournalDomainItem(
        db,
        target,
        {
          kind: 'item',
          identity: { provider: 'orca', clientMessageId: `studio-reply-${index}` },
          body: {
            kind: 'message',
            role: 'assistant',
            blocks: [
              {
                type: 'text',
                text: index === 0 ? 'The review is complete.' : 'The checklist is ready.'
              }
            ]
          },
          options: { turnScope: { kind: 'turn', turnItemId: agentJournalItemKey(turn) }, fence: 1 }
        },
        now++
      )
    }
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
            ...(withGroupReplies && index === 0 ? { completedAt: 40 } : {}),
            ...(linked
              ? {
                  userItemId: providerOpener
                    ? agentJournalItemKey(providerIdentity)
                    : agentJournalSubmissionKey(id)
                }
              : {})
          },
          options: { turnScope: { kind: 'thread' }, fence: 1 }
        },
        now++
      )
    )
  }
  for (let message = 0; message < lastTurnMessages; message += 1) {
    applyJournalDomainItem(
      db,
      target,
      {
        kind: 'item',
        identity: { provider: 'orca', clientMessageId: `note-${message}` },
        body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'note' }] },
        options: { turnScope: { kind: 'thread' }, fence: 1 }
      },
      now++
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
  if (withGroupReplies) {
    applyJournalDomainItem(
      db,
      target,
      {
        kind: 'item',
        identity: { provider: 'orca', clientMessageId: 'worker-start' },
        body: {
          kind: 'agent-start',
          dispatchId: 'worker-start',
          task: 'Check the Studio list.',
          worker: {
            name: 'Pilot',
            party: { address: 'dispatch:worker-start', terminalHandle: null, orcaSessionId: null }
          }
        },
        options: { turnScope: { kind: 'thread' }, fence: 1 }
      },
      now++
    )
  }
  db.exec('COMMIT')
  return db
}

it('recovers the same sidebar replies without reading the later chat history', async () => {
  for (const length of [10, 100]) {
    const journal = chat(length, undefined, undefined, 0, 0, 0, undefined, true)
    const database = new Database(':memory:')
    try {
      const work = { rows: 0, decodedBytes: 0 }
      live.operationWindow = async (anchors) =>
        readJournalDomainOperationWindow(
          new JournalSqlScope(journal, 'chat', 'epoch', work),
          anchors
        )
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mocked host lookup is the only consumer of this runtime
      const reads = botChatReads({} as never)
      const store = new BotGroupStore(database)
      store.put({
        id: 'studio',
        name: 'Studio',
        hostId: 'local',
        folder: 'studio',
        folderWorkspaceId: 'home',
        revision: 1,
        createdAt: 1,
        members: [],
        replyMode: { kind: 'mentions' }
      })
      const scout: BotGroupTurn = {
        botId: 'scout',
        botName: 'Scout',
        avatar: null,
        agent: 'codex',
        sessionId: 'chat',
        operationId: 'card-0',
        workerDispatchIds: ['worker-start']
      }
      store.append({
        id: 'post',
        groupId: 'studio',
        createdAt: 1,
        author: { kind: 'owner' },
        text: 'Status?',
        turns: [
          scout,
          { ...scout, botId: 'atlas', botName: 'Atlas', operationId: 'm1' },
          { ...scout, botId: 'pilot', botName: 'Pilot', operationId: 'follow-up-card' }
        ]
      })
      const result = await store.listing(true, (messages, cache) =>
        recoverBotGroupReplies(messages, reads, cache)
      )
      expect(
        result[0].replyPreviews?.map((row) => [
          row.botId,
          row.messageId,
          'operationId' in row ? row.operationId : null,
          row.text,
          row.at,
          row.replyMessageId
        ])
      ).toEqual([
        ['scout', 'post', 'card-0', 'The review is complete.', 40, 'orca:studio-reply-0'],
        ['atlas', 'post', 'm1', 'The checklist is ready.', null, 'orca:studio-reply-1'],
        ['pilot', 'post', 'follow-up-card', 'The review is complete.', 40, 'orca:studio-reply-0']
      ])
      expect(work.rows).toBeLessThanOrEqual(40)

      // New prose and a completion time can arrive after the next turn has already opened.
      if (length === 10) {
        const identity = codexTurnLifecycleIdentity('chat', 'turn-1')
        journal.exec('BEGIN IMMEDIATE')
        const revised = runJournalSqlSteps(
          journal,
          {
            target: { ...target, ownerToken: 'owner' },
            operation: {
              kind: 'steps',
              steps: [
                {
                  kind: 'resolved-item',
                  reservedBytes: 1024,
                  options: {
                    fence: 1,
                    turnScope: { kind: 'turn', turnItemId: agentJournalItemKey(identity) }
                  },
                  resolution: {
                    kind: 'guarded-item',
                    change: 'open',
                    identity: { provider: 'orca', clientMessageId: 'late-reply' },
                    body: {
                      kind: 'message',
                      role: 'assistant',
                      blocks: [{ type: 'text', text: 'The checklist was delivered.' }]
                    }
                  }
                },
                {
                  kind: 'resolved-item',
                  reservedBytes: 1024,
                  options: { fence: 1, turnScope: { kind: 'thread' } },
                  resolution: {
                    kind: 'turn-row',
                    target: { identity },
                    write: {
                      lifecycle: {
                        kind: 'turn',
                        turnId: 'turn-1',
                        state: 'completed',
                        outcome: 'success',
                        userItemId: agentJournalSubmissionKey('m1'),
                        completedAt: 50
                      }
                    }
                  }
                }
              ]
            }
          },
          51
        )
        journal.exec('COMMIT')
        expect(revised.value.outcomes).toEqual([
          { kind: 'committed', wrote: true },
          { kind: 'committed', wrote: true }
        ])
        store.append({
          id: 'new-post',
          groupId: 'studio',
          createdAt: 52,
          author: { kind: 'owner' },
          text: 'Hello',
          turns: [
            {
              ...scout,
              operationId: 'new',
              reply: 'Still reviewing.',
              replyAt: 35,
              replyMessageId: 'new-answer'
            }
          ]
        })
        const [refreshed] = await store.listing(true, (messages, cache) =>
          recoverBotGroupReplies(messages, reads, cache)
        )
        expect(refreshed.replyPreviews?.find(({ botId }) => botId === 'atlas')).toMatchObject({
          at: 50,
          text: 'The checklist is ready. The checklist was delivered.',
          replyMessageId: 'orca:studio-reply-1'
        })
      }
    } finally {
      journal.close()
      database.close()
    }
  }
})

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
  expect([short.examined, read(500, 491).examined]).toEqual([72, 72])
  expect(long.sends).toEqual(Array.from({ length: 9 }, (_, index) => `m${491 + index}`))
  expect(long.turns).toEqual(Array.from({ length: 9 }, (_, index) => `turn-${491 + index}`))
  // A long agent turn's tool calls are never listed to find its sends, and change nothing it reads:
  // each stretch a send read lists keys on the index that holds no tool rows.
  const listed = (tools: number) => {
    const db = chat(50, () => true, undefined, 0, tools)
    const prepare = db.prepare.bind(db)
    const statements = new Set<string>()
    db.prepare = (sql: string) => (statements.add(sql), prepare(sql))
    const { snapshot } = readJournalDomainOperationWindow(
      new JournalSqlScope(db, 'chat', 'epoch'),
      { latestTurns: 8, turnShape: true }
    )
    const stretches = [...statements].flatMap((sql) => {
      const plan = prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all()
        .map((step) => String(step.detail))
      return plan.some((step) => step.startsWith('SEARCH send'))
        ? plan.filter((step) => /journal_items .*sequence>\?/.test(step))
        : []
    })
    db.close()
    return { stretches, sends: snapshot.submissions.map((send) => send.clientMessageId) }
  }
  const few = listed(0)
  expect(listed(1000)).toEqual(few)
  expect(few.stretches.length).toBeGreaterThan(0)
  expect(few.stretches.every((step) => step.includes('journal_items_send_place'))).toBe(true)
  // Sends recovered in doubt long ago are settled for attribution: they add no work as they pile up.
  expect(read(500, 491).examined).toBe(read(50, 41).examined)
  // A send still unanswered anywhere is the turn still to be attributed: kept, as the whole read does,
  // and with the window pinned back to it the read costs no more than that whole read.
  const db = chat(500, () => true, 0)
  const pinned = new JournalSqlScope(db, 'chat', 'epoch')
  const { snapshot } = readJournalDomainOperationWindow(pinned, { latestTurns: 8, turnShape: true })
  const whole = new JournalSqlScope(db, 'chat', 'epoch')
  readJournalDomainOperationWindow(whole, { latestTurns: 8, turnShape: true, afterSequence: -1 })
  const own = new JournalSqlScope(db, 'chat', 'epoch')
  const anchored = readJournalDomainOperationWindow(own, {
    latestTurns: 8,
    turnShape: true,
    anchorsOnly: true
  })
  db.close()
  // The whole read plus the unanswered send's own row, which found it; a window of its
  // anchors alone holds no older send, so that send never pins it back.
  expect([own.work.rows, pinned.work.rows, whole.work.rows]).toEqual([74, 2000, 1999])
  expect(anchored.snapshot.submissions.map((send) => send.clientMessageId)).toEqual(long.sends)
  expect(snapshot.submissions.map((send) => send.clientMessageId)).toContain('m0')
})

it('walks a family of sends linked by provider id and queued card once, however long it is', () => {
  // Send i shares a provider id with i+1 when i is even and a queued card when odd; only the newest
  // sits in the window, so the whole chain is held through its links.
  const family = (size: number) => {
    let reads = 0
    const sends = Array.from({ length: size }, (_, index): Send => {
      const link = (odd: boolean, at: number) => (at % 2 === (odd ? 1 : 0) ? `l${at}` : null)
      const provider = link(false, index) ?? link(false, index - 1)
      const card = link(true, index) ?? link(true, index - 1)
      return {
        messageId: `m${index}`,
        itemId: `i${index}`,
        ordinal: index,
        dispatchState: 'accepted',
        recovered: false,
        get providerItemId() {
          reads++
          return provider
        },
        get queuedMessageId() {
          reads++
          return card
        },
        submittedSequence: null,
        positions: [index],
        answeredSequence: null
      }
    })
    const kept = keptSends(sends, new Set(), size - 1, null, false)
    return { kept: kept.length, reads }
  }
  expect([family(100), family(1000)]).toEqual([
    { kept: 100, reads: 798 },
    { kept: 1000, reads: 7998 }
  ])
})

// Builds twelve chats of up to 500 turns, about 30s on a Windows runner; it counts work, not time.
it('stops reading a long send family at its first member older than the newest turns', () => {
  // Every send is in one family running back through the chat, from the newest send (unanswered or
  // not): the first older member settles the whole read, so the rest is never walked by index.
  const extra = (
    turns: number,
    unanswered: boolean,
    family: 'chain' | 'card' | 'answered' | 'unsettled' = 'chain'
  ) => {
    const db = chat(turns, () => true, unanswered ? turns - 1 : undefined, 0, 0, 0, family)
    const pinned = new JournalSqlScope(db, 'chat', 'epoch')
    const read = readJournalDomainOperationWindow(pinned, { latestTurns: 8, turnShape: true })
    const whole = new JournalSqlScope(db, 'chat', 'epoch')
    const all = readJournalDomainOperationWindow(whole, {
      latestTurns: 8,
      turnShape: true,
      afterSequence: -1
    })
    db.close()
    const ids = (window: typeof read) =>
      window.snapshot.submissions.map((send) => send.clientMessageId)
    expect(ids(read)).toEqual(ids(all))
    return pinned.work.rows - whole.work.rows
  }
  expect([extra(50, true), extra(500, true), extra(50, false), extra(500, false)]).toEqual([
    31, 31, 46, 46
  ])
  // One card every send carries: each lookup lists at most the cap, however wide the family.
  expect([extra(200, true, 'card'), extra(500, true, 'card')]).toEqual([67, 67])
  expect([extra(200, false, 'card'), extra(500, false, 'card')]).toEqual([110, 110])
  // One answering turn, in the window, that every send names: the window's own lookup stops at the cap.
  expect([extra(200, false, 'answered'), extra(500, false, 'answered')]).toEqual([74, 74])
  // Unsettled sends piled up before the newest turns: their lookup stops at the cap too.
  expect([extra(200, false, 'unsettled'), extra(500, false, 'unsettled')]).toEqual([65, 65])
}, 120_000)

it('takes the whole read for a window crowded with rows rather than listing them to place its sends', () => {
  const lookups = (messages: number) => {
    const db = chat(50, () => true, undefined, 0, 0, messages)
    const prepare = db.prepare.bind(db)
    let placing = 0
    db.prepare = (sql: string) => {
      placing +=
        sql.includes('journal_items_send_place') && sql.includes('journal_submission') ? 1 : 0
      return prepare(sql)
    }
    const { snapshot } = readJournalDomainOperationWindow(
      new JournalSqlScope(db, 'chat', 'epoch'),
      {
        latestTurns: 8,
        turnShape: true
      }
    )
    db.close()
    return { placing, sends: snapshot.submissions.map((send) => send.clientMessageId) }
  }
  const newest = Array.from({ length: 9 }, (_, index) => `m${41 + index}`)
  expect([lookups(0), lookups(2000)]).toEqual([
    { placing: 3, sends: newest },
    { placing: 0, sends: newest }
  ])
})

it('reads an indexed-only window of the newest turn by index, and throws where only the whole read answers', () => {
  const read = (db: Database) => {
    const scope = new JournalSqlScope(db, 'chat', 'epoch')
    try {
      const { snapshot } = readJournalDomainOperationWindow(scope, {
        latestTurns: 1,
        turnShape: true,
        anchorsOnly: true,
        indexedOnly: true
      })
      return {
        rows: scope.work.rows,
        sends: snapshot.submissions.map((send) => send.clientMessageId)
      }
    } catch (error) {
      return { rows: scope.work.rows, thrown: error instanceof JournalWindowNotIndexed }
    } finally {
      db.close()
    }
  }
  // An older unanswered send never pins this read back, however long the chat.
  expect([read(chat(50, () => true, 0)), read(chat(500, () => true, 0))]).toEqual([
    { rows: 18, sends: ['m48', 'm49'] },
    { rows: 18, sends: ['m498', 'm499'] }
  ])
  // A family it would have to read whole: it stops at the cap and throws, never reading every send.
  expect([
    read(chat(200, () => true, undefined, 0, 0, 0, 'card')),
    read(chat(500, () => true, undefined, 0, 0, 0, 'card'))
  ]).toEqual([
    { rows: 75, thrown: true },
    { rows: 75, thrown: true }
  ])
  // Tool calls are dropped row by row: past the cap the read stops on the index, before any is read.
  expect([
    read(chat(50, () => true, undefined, 0, 100)),
    read(chat(50, () => true, undefined, 0, 5000))
  ]).toEqual([
    { rows: 16, sends: ['m48', 'm49'] },
    { rows: 10, thrown: true }
  ])
})

// #47789: an item add's look back walked every root row ahead of a resumed turn.
it('looks back for the turn ahead of an indexed-only window no further than the window could reach', () => {
  // A turn resumed from the provider with no prompt of its own, after a long run of root tool calls:
  // the prompt ahead of it sits behind every one of them.
  const resumedAfter = (tools: number) => {
    const db = chat(1, () => true, undefined, 0, tools)
    db.exec('BEGIN IMMEDIATE')
    applyJournalDomainItem(
      db,
      target,
      {
        kind: 'item',
        identity: codexTurnLifecycleIdentity('chat', 'resumed'),
        body: { kind: 'turn', turnId: 'resumed', state: 'completed', outcome: 'success' },
        options: { turnScope: { kind: 'thread' }, fence: 1 }
      },
      1_900_000_000_000
    )
    db.exec('COMMIT')
    return db
  }
  const lookBack = (db: Database, indexedOnly: boolean) => {
    const scope = new JournalSqlScope(db, 'chat', 'epoch')
    try {
      return marginBefore(scope, Number.MAX_SAFE_INTEGER, indexedOnly)
    } catch (error) {
      return error instanceof JournalWindowNotIndexed ? 'thrown' : error
    }
  }
  const near = resumedAfter(100)
  const far = resumedAfter(5000)
  try {
    expect([lookBack(near, true), lookBack(near, false)]).toEqual([1, 1])
    expect([lookBack(far, true), lookBack(far, false)]).toEqual(['thrown', 1])
  } finally {
    near.close()
    far.close()
  }
})

// #47789: an item add's look back for the turn ahead once tested every row up to its cap.
it('stops its look back for the turn ahead at the nearest match, however long the chat ran', () => {
  // Counts each candidate SQLite tests for the prompt: the nearest is right ahead at 100 and 1,000 turns.
  const look = (turns: number) => {
    const db = chat(turns)
    let tested = 0
    let probes = 0
    db.function('tested', (hit) => {
      tested += 1
      return hit
    })
    const prepare = db.prepare.bind(db)
    db.prepare = (sql: string) => {
      probes += sql.includes('OFFSET') ? 1 : 0
      const prompt = "kind='message' AND message_role='user'"
      return prepare(sql.replaceAll(prompt, `tested(${prompt})`))
    }
    const found = marginBefore(
      new JournalSqlScope(db, 'chat', 'epoch'),
      Number.MAX_SAFE_INTEGER,
      true
    )
    db.close()
    return { found: found > 0, tested, probes }
  }
  expect([look(100), look(1000)]).toEqual([
    { found: true, tested: 1, probes: 0 },
    { found: true, tested: 1, probes: 0 }
  ])
})
