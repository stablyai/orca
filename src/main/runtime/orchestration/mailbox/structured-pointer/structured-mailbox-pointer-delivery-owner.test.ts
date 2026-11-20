import { describe, expect, it, vi } from 'vitest'
import type { RuntimeOrchestrationSenderNames } from '../senders/runtime-orchestration-sender-names'
import type { OrchestrationDb } from '../../db/orchestration-db'
import '../../db/contract-constants'
import '../../db/messages/mailbox-routing-page'
import '../../db/dispatch-row-writer'
import '../../db/attempt-outcome-projection'
import { OrchestrationStructuredMailboxPointerDelivery } from './structured-mailbox-pointer-delivery'
import type {
  StructuredMailboxPointerHost,
  StructuredPointerSendOutcome
} from './structured-mailbox-pointer-host-contract'
import type { StructuredSendAnswer as StructuredMailSendState } from '../../../../native-chat/agent-session-wire/delivery/structured-agent-session-queued-send-answer'
import type { StructuredMailSendRow } from '../../db/messages/structured-mail-send-store'

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
function harness(
  options: {
    busy?: boolean
    narrowBatch?: StructuredMailboxPointerHost['narrowBatch']
    senderNames?: RuntimeOrchestrationSenderNames
  } = {}
) {
  const mailbox = 'dispatch:d1'
  const mail = new Map<string, Mail>()
  const records = new Map<string, StructuredMailSendRow>()
  let busy = options.busy ?? false
  let owner = 'session-1'
  let ended = false
  let held = false
  /** The next sends' answers, in order; a send with none queued or starts a turn. */
  const answers: ((operationId: string) => Promise<StructuredPointerSendOutcome>)[] = []
  /** What each chat holds per operation id: a waiting card, or what its handoff became. */
  const chat = new Map<string, StructuredMailSendState>()
  const sent: { sessionId: string; operationId: string; text: string }[] = []
  const watching = new Map<string, () => void>()
  const systemWithdrawals = new Set<string>()
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
  const host: StructuredMailboxPointerHost = {
    currentFence: () => 4,
    watchJournal: (sessionId, onActivity) => {
      watching.set(sessionId, onActivity)
      return () => watching.delete(sessionId)
    },
    send: vi.fn(async (input) => {
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
      body: null,
      withdrawal: systemWithdrawals.has(attempt.operation_id) ? 'system' : 'person'
    }),
    wakeQueue: vi.fn(),
    withdraw: vi.fn(async (_sessionId: string, operationId: string) => {
      systemWithdrawals.add(operationId)
      const withdrawn = { kind: 'withdrawn' as const }
      chat.set(operationId, withdrawn)
      return withdrawn
    }),
    mailHeld: (sessionId) => held && sessionId === owner,
    ...(options.narrowBatch ? { narrowBatch: options.narrowBatch } : {})
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
    /** The queue's question choosing its next card, for a card carrying message `id`. */
    handover: (sessionId: string, id: string) =>
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
    /** The owner holding the chat's mail, as a paused bot's chat. */
    setHeld: (next: boolean) => {
      held = next
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

describe('structured mailbox delivery: an owner that narrows its mail', () => {
  it('sends only the mail its owner narrows to and retires the mail it ended', async () => {
    const h = harness({
      narrowBatch: (_session, messages) => ({
        messages: messages.filter((message) => message.id === 'm2'),
        ended: messages.some((message) => message.id === 'm1') ? ['m1'] : []
      })
    })
    h.receive('m1')
    h.receive('m2')
    h.receive('m3')
    await h.deliver()
    expect(h.sent.map((send) => send.text)).toEqual([expect.stringContaining('body of m2')])
    expect(h.mail.get('m1')).toMatchObject({ read: 0, delivered_at: 'now' })
    expect(h.mail.get('m3')).toMatchObject({ delivered_at: null })
  })

  it('withdraws a waiting card whose mail its owner has since ended, and retires the mail', async () => {
    let stopped = false
    const h = harness({
      busy: true,
      narrowBatch: (_session, messages) =>
        stopped
          ? { messages: [], ended: messages.map((message) => message.id) }
          : { messages, ended: [] }
    })
    h.receive('m1')
    await h.deliver()
    expect(h.sent).toHaveLength(1)
    stopped = true
    expect(h.handover('session-1', 'm1')).toBe('stale')
    h.delivery.onJournalActivity('session-1')
    await flush()
    expect(h.sent).toHaveLength(1)
    expect(h.records.size).toBe(0)
    expect(h.mail.get('m1')).toMatchObject({ read: 0, delivered_at: 'now' })
  })
})

describe('structured mailbox delivery: a chat its owner holds (a paused bot)', () => {
  it('keeps new mail unread with no turn, then delivers it in order on release', async () => {
    const h = harness()
    h.setHeld(true)
    h.receive('m1')
    h.receive('m2')
    await h.deliver()
    expect(h.host.send).not.toHaveBeenCalled()
    expect(h.mail.get('m1')).toMatchObject({ read: 0, delivered_at: null })
    expect(h.mail.get('m2')).toMatchObject({ read: 0, delivered_at: null })

    h.setHeld(false)
    // The release edge: the chat's idle-edge redrive.
    h.delivery.onJournalActivity('session-1')
    await h.deliver()
    expect(h.sent.map((send) => send.text)).toEqual([
      expect.stringContaining('body of m1'),
      expect.stringContaining('body of m2')
    ])
  })

  it('holds the rest of a batch when a held chat takes the mailbox over mid-send', async () => {
    const h = harness()
    h.receive('m1')
    h.receive('m2')
    h.answers.push(async (operationId) => {
      h.chat.set(operationId, { kind: 'accepted' })
      h.setOwner('session-2')
      h.setHeld(true)
      return { kind: 'sent', state: 'accepted' }
    })
    await h.deliver()
    expect(h.host.send).toHaveBeenCalledTimes(1)
    expect(h.host.send).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-1' }))
    expect(h.mail.get('m2')).toMatchObject({ read: 0, delivered_at: null })
  })

  it('keeps a card already queued in place until release', async () => {
    const h = harness({ busy: true })
    h.receive('m1')
    await h.deliver()
    h.setHeld(true)
    expect(h.handover('session-1', 'm1')).toBe('unavailable')
    expect(h.records.has('m1')).toBe(true)
    expect(h.mail.get('m1')?.read).toBe(0)

    h.setHeld(false)
    expect(h.handover('session-1', 'm1')).toBe('owed')
  })
})
