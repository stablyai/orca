import { mkdtempSync, rmSync } from 'node:fs'

import { tmpdir } from 'node:os'

import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import type { RuntimeOrchestrationSenderNames } from '../senders/runtime-orchestration-sender-names'

import { OrchestrationDb } from '../../db/orchestration-db'

import '../../db/contract-constants'
import '../../db/messages/mailbox-routing-page'
import '../../db/dispatch-row-writer'
import '../../db/attempt-outcome-projection'
import { OrchestrationStructuredMailboxPointerDelivery } from './structured-mailbox-pointer-delivery'

import { structuredMailMessage } from '../structured-mail/structured-mail-source'
import { settleStructuredMailAttempt } from '../structured-mail/structured-mail-custody'

import type {
  StructuredMailboxPointerHost,
  StructuredPointerSendOutcome
} from './structured-mailbox-pointer-host-contract'

import type { StructuredSendAnswer as StructuredMailSendState } from '../../../../native-chat/agent-session-wire/delivery/structured-agent-session-queued-send-answer'

import type { StructuredMailSendRow } from '../../db/messages/structured-mail-send-store'

import type { AgentJournalMessageItem } from '../../../../../shared/agent-session/journal/agent-session-journal-types'

type Mail = {
  id: string
  type: string
  sequence: number
  from_handle: string
  to_handle: string
  run_id: string
  subject: string
  body: string
  payload: string | null
  priority: string
  delivery_contract: string
  read: number
  delivered_at: string | null
}

/** dispatch:d1 behind one chat session at a time: idle sends start a turn, busy ones wait as cards. */
function harness(options: { busy?: boolean; senderNames?: RuntimeOrchestrationSenderNames } = {}) {
  const mailbox = 'dispatch:d1'
  const mail = new Map<string, Mail>()
  const records = new Map<string, StructuredMailSendRow>()
  let busy = options.busy ?? false
  let owner = 'session-1'
  let ended = false
  /** The next sends' answers, in order; a send with none queued or starts a turn. */
  const answers: ((operationId: string) => Promise<StructuredPointerSendOutcome>)[] = []
  /** What each chat holds per operation id: a waiting card, or what its handoff became. */
  const chat = new Map<string, StructuredMailSendState>()
  const sent: { sessionId: string; operationId: string; text: string }[] = []
  const watching = new Map<string, () => void>()
  const db = {
    getRun: () => undefined,
    getDispatchContextById: () => ({ run_id: 'run_1' }),
    getOutstandingMailboxDelivery: () => undefined,
    getUndeliveredUnreadMessages: (handle: string) =>
      [...mail.values()].filter(
        (row) => row.to_handle === handle && !row.read && row.delivered_at === null
      ),
    areUnreadMessages: (handle: string, ids: string[]) =>
      ids.every((id) => mail.get(id)?.read === 0 && mail.get(id)?.to_handle === handle),
    getMessageById: (id: string) => mail.get(id),
    markAsDelivered: (ids: string[]) => {
      for (const id of ids) {
        mail.get(id)!.delivered_at ??= 'now'
      }
    },
    markAsUndelivered: (ids: string[]) => {
      for (const id of ids) {
        mail.get(id)!.delivered_at = null
      }
    },
    markAsReadAndDelivered: (ids: string[]) => {
      for (const id of ids) {
        Object.assign(mail.get(id)!, { read: 1, delivered_at: 'now' })
      }
    },
    getStructuredMailSends: (handle: string) =>
      [...records.values()].filter((row) => row.mailbox_handle === handle),
    getStructuredMailSend: (_handle: string, id: string) => records.get(id),
    hasStructuredMailSend: (handle: string) =>
      [...records.values()].some((row) => row.mailbox_handle === handle),
    getStructuredMailSendMailboxesForSession: (sessionId: string) => [
      ...new Set(
        [...records.values()]
          .filter((row) => row.session_id === sessionId)
          .map((row) => row.mailbox_handle)
      )
    ],
    getStructuredMailSendMailboxes: () => [
      ...new Set([...records.values()].map((row) => row.mailbox_handle))
    ],
    reserveStructuredMailSend: (row: StructuredMailSendRow, replacing?: string) => {
      const current = records.get(row.message_id)
      if (replacing === undefined ? current : current?.operation_id !== replacing) {
        return false
      }
      records.set(row.message_id, row)
      mail.get(row.message_id)!.delivered_at ??= 'now'
      return true
    },
    releaseStructuredMailSend: (row: StructuredMailSendRow) => {
      if (records.get(row.message_id)?.operation_id !== row.operation_id) {
        return false
      }
      records.delete(row.message_id)
      if (!mail.get(row.message_id)!.read) {
        mail.get(row.message_id)!.delivered_at = null
      }
      return true
    },
    retireStructuredMailSend: (row: StructuredMailSendRow, consumed: boolean) => {
      if (records.get(row.message_id)?.operation_id !== row.operation_id) {
        return false
      }
      records.delete(row.message_id)
      const message = mail.get(row.message_id)!
      Object.assign(
        message,
        { delivered_at: message.delivered_at ?? 'now' },
        consumed && { read: 1 }
      )
      return true
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake implements every OrchestrationDb method the delivery and its custody reads call; the class's other members are never reached.
  const orchestrationDb = db as unknown as OrchestrationDb
  const admitted = new Map<string, AgentJournalMessageItem>()
  const systemWithdrawals = new Set<string>()
  const host: StructuredMailboxPointerHost = {
    currentFence: () => 4,
    watchJournal: (sessionId, onActivity) => {
      watching.set(sessionId, onActivity)
      return () => watching.delete(sessionId)
    },
    send: vi.fn(async (input) => {
      admitted.set(input.operationId, structuredClone(input.body))
      const answer = answers.shift()
      if (!input.stillOwed()) {
        return { kind: 'obsolete' as const }
      }
      if (answer) {
        return answer(input.operationId)
      }
      sent.push({
        sessionId: input.sessionId,
        operationId: input.operationId,
        text: input.body.blocks.map((block) => ('text' in block ? block.text : '')).join('')
      })
      chat.set(input.operationId, { kind: busy ? 'waiting' : 'accepted' })
      return busy
        ? { kind: 'queued' as const }
        : { kind: 'sent' as const, state: 'accepted' as const }
    }),
    observe: vi.fn(
      async (_sessionId, operationId) => chat.get(operationId) ?? { kind: 'absent' as const }
    ),
    observeMail: async (attempt) => ({
      epoch: 'test',
      state: chat.get(attempt.operation_id) ?? { kind: 'absent' },
      body: admitted.get(attempt.operation_id) ?? null,
      withdrawal: systemWithdrawals.has(attempt.operation_id) ? 'system' : 'person'
    }),
    wakeQueue: vi.fn(),
    withdraw: vi.fn<StructuredMailboxPointerHost['withdraw']>(async (_sessionId, operationId) => {
      systemWithdrawals.add(operationId)
      chat.set(operationId, { kind: 'withdrawn' })
      return { kind: 'withdrawn' }
    })
  }
  const start = () =>
    new OrchestrationStructuredMailboxPointerDelivery({
      getDb: () => orchestrationDb,
      getMessageWaiters: () => undefined,
      resolveStructuredTarget: (handle) =>
        handle === mailbox && !ended ? { sessionId: owner, dispatchId: 'd1' } : null,
      mailboxEnded: () => ended,
      unresolvedCustody: () => 'unverifiable',
      getCliCommand: () => 'orca-dev',
      senderSnapshot: () => ({ name: 'Coordinator', agent: null }),
      senderSnapshotReader: options.senderNames
        ? () => options.senderNames!.snapshotReader()
        : undefined,
      host
    })
  let delivery = start()
  let sequence = 0
  const operation = (id: string) => records.get(id)!.operation_id
  return {
    get delivery() {
      return delivery
    },
    /** Orca starting again over the same databases: nothing settled is remembered. */
    restart: () => {
      delivery = start()
    },
    host,
    /** The queue's question at handover, for a card carrying message `id`. */
    owed: (sessionId: string, id: string) =>
      delivery.owedNow(
        sessionId,
        {
          kind: 'agent',
          senders: [],
          orchestration: {
            message: 'mail-notice',
            mailbox,
            dispatchId: 'd1',
            messages: [{ messageId: id, runId: 'run_1', from: 'term_coord' }]
          }
        },
        orchestrationDb
      ),
    mail,
    records,
    chat,
    sent,
    answers,
    watching,
    operation,
    receive: (id: string, body = `body of ${id}`) => {
      mail.set(id, {
        id,
        type: 'status',
        sequence: ++sequence,
        from_handle: 'term_coord',
        to_handle: mailbox,
        run_id: 'run_1',
        subject: `subject of ${id}`,
        body,
        payload: null,
        priority: 'normal',
        delivery_contract: 'standard',
        read: 0,
        delivered_at: null
      })
    },
    deliver: async () => {
      delivery.deliverForHandle(mailbox)
      await flush()
    },
    /** A journal publication on the session's watch, as a freed queue or a handover writes. */
    journal: async (sessionId = owner) => {
      watching.get(sessionId)?.()
      await flush()
    },
    settle: (id: string, state: StructuredMailSendState) => chat.set(operation(id), state),
    setBusy: (next: boolean) => {
      busy = next
    },
    setOwner: (next: string) => {
      owner = next
    },
    end: () => {
      ended = true
    }
  }
}

const flush = async () => {
  for (let i = 0; i < 8; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

describe('structured mailbox delivery: each message whole', () => {
  it('settles a handoff that wins stale-card withdrawal without sending it to the new owner', async () => {
    const h = harness({ busy: true })
    h.receive('m1')
    await h.deliver()
    const first = h.operation('m1')
    h.setOwner('session-2')
    vi.mocked(h.host.withdraw).mockImplementationOnce(async (_sessionId, operationId) => {
      h.chat.set(operationId, { kind: 'accepted' })
      return { kind: 'accepted' }
    })
    h.delivery.withdrawStale()
    await vi.waitFor(() => expect(h.mail.get('m1')?.read).toBe(1))
    expect(h.records.size).toBe(0)
    expect(h.sent.map(({ sessionId, operationId }) => [sessionId, operationId])).toEqual([
      ['session-1', first]
    ])
    expect(h.mail.get('m1')?.delivered_at).toBe('now')
  })
})

describe('structured mailbox delivery across a real database close and reopen', () => {
  it('keeps a real lifecycle correction unread when the earlier accepted body lacks that correction', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-mail-correction-'))
    const db = new OrchestrationDb(join(directory, 'orchestration.db'))
    try {
      const run = db.createRun({
        objective: 'correction',
        coordinatorHandle: 'term_coord',
        coordinatorPaneKey: null
      })
      const mailbox = `run:${run.id}`
      const message = db.insertMessage({
        runId: run.id,
        from: 'term_worker',
        to: mailbox,
        type: 'worker_done',
        subject: 'Done',
        body: 'original report',
        payload: '{}'
      })
      const attempt = {
        mailbox_handle: mailbox,
        message_id: message.id,
        session_id: 'session-1',
        operation_id: 'old-admission',
        minted_at_ms: 100
      }
      expect(db.reserveStructuredMailSend(attempt)).toBe(true)
      const admitted = structuredMailMessage({
        db,
        mailboxHandle: mailbox,
        dispatchId: null,
        message,
        cliCommand: 'orca-dev',
        senderSnapshot: () => ({ name: null, agent: null })
      }).body
      settleStructuredMailAttempt(
        db,
        attempt,
        {
          epoch: 'epoch',
          state: { kind: 'accepted' },
          body: admitted,
          withdrawal: 'unknown'
        },
        () => 'owed'
      )
      expect(db.getUnreadMessages(mailbox)).toMatchObject([
        {
          subject: 'Rejected worker_done: Done',
          body: expect.stringContaining('Orca rejected this worker_done')
        }
      ])
      expect(db.getStructuredMailSends(mailbox)).toEqual([])
    } finally {
      db.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
