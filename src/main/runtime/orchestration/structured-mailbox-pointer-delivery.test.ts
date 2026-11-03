import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from './db'
import { OrchestrationStructuredMailboxPointerDelivery } from './structured-mailbox-pointer-delivery'
import { StructuredMailboxParking } from './structured-mailbox-parking'
import type {
  StructuredMailboxPointerHost,
  StructuredMailSendState,
  StructuredPointerSendOutcome
} from './structured-mailbox-pointer-host-contract'
import type { StructuredMailSendRow } from './db/messages/structured-mail-send-store'
import { MAX_PROMPT_BYTES } from '../../../shared/rpc-contract/structured-agent-session-message-params'

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
function harness(options: { busy?: boolean } = {}) {
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
    wakeQueue: vi.fn(),
    withdraw: vi.fn(async (_sessionId, operationId) => {
      chat.set(operationId, { kind: 'withdrawn' })
      return true
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
    handover: (sessionId: string, id: string) =>
      delivery.owedAtHandover(
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
  it('hands an idle chat the whole message and marks it read', async () => {
    const h = harness()
    h.receive('m1', 'Tests pass; PR #12 is ready.')
    await h.deliver()
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]!.text).toContain('Subject: subject of m1')
    expect(h.sent[0]!.text).toContain('Tests pass; PR #12 is ready.')
    expect(h.sent[0]!.text).toContain('[Reply: orca-dev orchestration reply --id m1')
    expect(h.mail.get('m1')).toMatchObject({ read: 1 })
    expect(h.records.size).toBe(0)
  })

  it('queues each message as its own card while the chat works, reading each on handover', async () => {
    const h = harness({ busy: true })
    h.receive('m1')
    h.receive('m2')
    await h.deliver()
    expect(h.sent.map((send) => send.text)).toEqual([
      expect.stringContaining('body of m1'),
      expect.stringContaining('body of m2')
    ])
    // The chat holds both, so check still shows them until the agent is handed each.
    expect(h.mail.get('m1')).toMatchObject({ read: 0, delivered_at: 'now' })
    h.settle('m1', { kind: 'accepted' })
    await h.journal()
    expect(h.mail.get('m1')?.read).toBe(1)
    expect(h.mail.get('m2')?.read).toBe(0)
    expect(h.records.has('m2')).toBe(true)
    expect(h.host.send).toHaveBeenCalledTimes(2)
  })

  it('deletes the waiting card when a check takes its message first', async () => {
    const h = harness({ busy: true })
    h.receive('m1')
    await h.deliver()
    const operationId = h.operation('m1')
    h.mail.get('m1')!.read = 1
    h.delivery.withdrawStale()
    await flush()
    expect(h.host.withdraw).toHaveBeenCalledWith('session-1', operationId)
    expect(h.records.size).toBe(0)
    expect(h.mail.get('m1')?.read).toBe(1)
  })

  it('never sends a message twice when its card already waits after a restart', async () => {
    const h = harness({ busy: true })
    h.receive('m1')
    await h.deliver()
    // A crash before the delivered stamp: the record and the card survive, the stamp does not.
    h.mail.get('m1')!.delivered_at = null
    h.restart()
    await h.deliver()
    expect(h.host.send).toHaveBeenCalledTimes(1)
    expect(h.mail.get('m1')?.delivered_at).toBe('now')
  })

  it('admits a recorded send that never landed under the same id', async () => {
    const h = harness({ busy: true })
    h.receive('m1')
    await h.deliver()
    const first = h.operation('m1')
    // Recorded, then Orca stopped before the host admitted it.
    h.chat.delete(first)
    h.restart()
    await h.deliver()
    expect(h.host.send).toHaveBeenCalledTimes(2)
    expect(h.sent.map((send) => send.operationId)).toEqual([first, first])
    expect(h.operation('m1')).toBe(first)
  })

  it('never sends again a message that may have reached the agent', async () => {
    const h = harness({ busy: true })
    h.receive('m1')
    await h.deliver()
    h.settle('m1', { kind: 'unknown' })
    await h.journal()
    await h.deliver()
    expect(h.host.send).toHaveBeenCalledTimes(1)
    // Still unread for `check`, and nothing left to follow.
    expect(h.mail.get('m1')).toMatchObject({ read: 0, delivered_at: 'now' })
    expect(h.records.size).toBe(0)
  })

  it('sends a proven rejection again once, under a new id, only after a later turn or clear', async () => {
    const h = harness()
    h.receive('m1')
    h.answers.push(async (operationId) => {
      h.chat.set(operationId, { kind: 'rejected', cancelled: false, recovered: false })
      return { kind: 'sent', state: 'rejected' }
    })
    await h.deliver()
    const first = h.operation('m1')
    await h.deliver()
    await h.deliver()
    expect(h.host.send).toHaveBeenCalledTimes(1)
    expect(h.mail.get('m1')?.read).toBe(0)

    h.chat.set(first, { kind: 'rejected', cancelled: false, recovered: true })
    // Two passes that both see the recovery still send it once.
    h.delivery.withdrawStale()
    await h.deliver()
    expect(h.host.send).toHaveBeenCalledTimes(2)
    expect(h.sent.map((send) => send.operationId)).toEqual([expect.not.stringMatching(first)])
    expect(h.mail.get('m1')?.read).toBe(1)
  })

  it('keeps a stopped send unread for check and never repeats it', async () => {
    const h = harness()
    h.receive('m1')
    h.answers.push(async (operationId) => {
      h.chat.set(operationId, { kind: 'rejected', cancelled: true, recovered: true })
      return { kind: 'sent', state: 'rejected' }
    })
    await h.deliver()
    // The stop settles the handoff: a journal edge on the chat.
    await h.journal()
    expect(h.host.send).toHaveBeenCalledTimes(1)
    expect(h.records.size).toBe(0)
    expect(h.mail.get('m1')).toMatchObject({ read: 0, delivered_at: 'now' })
  })

  it('keeps refused mail unstamped and retries it on the session’s next journal edge', async () => {
    const h = harness()
    h.receive('m1')
    h.answers.push(async () => ({ kind: 'refused' }))
    await h.deliver()
    expect(h.mail.get('m1')).toMatchObject({ read: 0, delivered_at: null })
    expect(h.records.size).toBe(0)
    await h.journal()
    expect(h.mail.get('m1')?.read).toBe(1)
  })

  it('still retries a refusal when an edge arrived while that send was in flight', async () => {
    const h = harness()
    h.receive('m1')
    let refuse!: () => void
    h.answers.push(
      () =>
        new Promise<StructuredPointerSendOutcome>((resolve) => {
          refuse = () => resolve({ kind: 'refused' })
        })
    )
    h.delivery.deliverForHandle('dispatch:d1')
    await flush()
    // The queue frees room and its journal publishes before the refusal returns.
    await h.journal()
    refuse()
    await flush()
    // The edge during the send was not lost: one more pass ran after it.
    expect(h.mail.get('m1')?.read).toBe(1)
    expect(h.host.send).toHaveBeenCalledTimes(2)
  })

  it('parks without spinning on a refusal, and delivers on the next journal edge', async () => {
    const h = harness()
    h.receive('m1')
    h.answers.push(async () => ({ kind: 'refused' }))
    await h.deliver()
    await flush()
    // No edge, no retry.
    expect(h.host.send).toHaveBeenCalledTimes(1)
    expect(h.watching.has('session-1')).toBe(true)
    await h.journal()
    expect(h.host.send).toHaveBeenCalledTimes(2)
    expect(h.mail.get('m1')?.read).toBe(1)
    // Nothing parked any more: the next publication ends the watch.
    await h.journal()
    expect(h.watching.has('session-1')).toBe(false)
  })

  it('sends the rest of a batch to the new owner after a takeover during the first send', async () => {
    const h = harness({ busy: true })
    h.receive('m1')
    h.receive('m2')
    h.answers.push(async (operationId) => {
      h.chat.set(operationId, { kind: 'waiting' })
      h.setOwner('session-2')
      return { kind: 'queued' }
    })
    await h.deliver()
    // m2 follows the takeover; m1's card in the former chat is withdrawn and m1 follows too.
    expect(h.sent.map((send) => [send.sessionId, send.text.match(/body of m\d/)?.[0]])).toEqual([
      ['session-2', 'body of m2'],
      ['session-2', 'body of m1']
    ])
    expect(h.host.withdraw).toHaveBeenCalledTimes(1)
    expect(h.records.get('m2')?.session_id).toBe('session-2')
  })

  it('withdraws a former owner’s waiting card and hands the mail to the new owner', async () => {
    const h = harness({ busy: true })
    h.receive('m1')
    await h.deliver()
    const first = h.operation('m1')
    h.setOwner('session-2')
    h.delivery.withdrawStale()
    await flush()
    expect(h.host.withdraw).toHaveBeenCalledWith('session-1', first)
    expect(h.sent.map((send) => send.sessionId)).toEqual(['session-1', 'session-2'])
    // The old card's deletion was Orca's, not the person's: the mail was not marked read.
    expect(h.mail.get('m1')).toMatchObject({ read: 0, delivered_at: 'now' })
  })

  it('settles a card the queue dropped at handover so its deletion never reads as the person’s', async () => {
    const h = harness({ busy: true })
    h.receive('m1')
    await h.deliver()
    const first = h.operation('m1')
    h.setOwner('session-2')
    expect(h.handover('session-1', 'm1')).toBe('stale')
    h.chat.set(first, { kind: 'withdrawn' })
    await flush()
    expect(h.sent.map((send) => send.sessionId)).toEqual(['session-1', 'session-2'])
    expect(h.mail.get('m1')?.read).toBe(0)
  })

  it('withdraws waiting cards of a Dispatch that ended, keeping the mail unread', async () => {
    const h = harness({ busy: true })
    h.receive('m1')
    await h.deliver()
    const card = h.operation('m1')
    h.end()
    h.delivery.withdrawStale()
    await flush()
    expect(h.host.withdraw).toHaveBeenCalledWith('session-1', card)
    expect(h.records.size).toBe(0)
    expect(h.host.send).toHaveBeenCalledTimes(1)
    expect(h.mail.get('m1')).toMatchObject({ read: 0, delivered_at: null })
    // The queue asks the same question at handover, should the card still be there.
    expect(h.handover('session-1', 'm1')).toBe('stale')
  })

  it('points a message too large for one chat message at check, and withdraws it when check takes it', async () => {
    const h = harness({ busy: true })
    h.receive('m1', 'x'.repeat(MAX_PROMPT_BYTES))
    await h.deliver()
    expect(h.sent.map((send) => send.text)).toEqual([
      'You have 1 orchestration message. Run `orca-dev orchestration check`.'
    ])
    expect(h.mail.get('m1')).toMatchObject({ read: 0, delivered_at: 'now' })
    const pointer = h.operation('m1')
    h.mail.get('m1')!.read = 1
    h.delivery.withdrawStale()
    await flush()
    expect(h.host.withdraw).toHaveBeenCalledWith('session-1', pointer)
    expect(h.records.size).toBe(0)
  })

  it('leaves an oversized message unread when its pointer is handed over', async () => {
    const h = harness({ busy: true })
    h.receive('m1', 'x'.repeat(MAX_PROMPT_BYTES))
    await h.deliver()
    h.settle('m1', { kind: 'accepted' })
    await h.journal()
    expect(h.mail.get('m1')).toMatchObject({ read: 0, delivered_at: 'now' })
    expect(h.records.size).toBe(0)
  })

  it('consumes an oversized message when the person deletes its pointer card', async () => {
    const h = harness({ busy: true })
    h.receive('m1', 'x'.repeat(MAX_PROMPT_BYTES))
    await h.deliver()
    h.settle('m1', { kind: 'withdrawn' })
    await h.journal()
    expect(h.mail.get('m1')).toMatchObject({ read: 1, delivered_at: 'now' })
    expect(h.records.size).toBe(0)
  })
})

describe('what the lane remembers about settled mailboxes', () => {
  /** The in-memory settle bookkeeping still held: per-mailbox change counts and last settles. */
  const retained = (h: ReturnType<typeof harness>) =>
    h.delivery['settledState']['changes'].size + h.delivery['settledState']['settled'].size

  it.each([4, 40])(
    'keeps nothing for %i ended mailboxes cleaned up with no mail ever sent',
    async (count) => {
      const h = harness()
      const gone = Array.from({ length: count }, (_, index) => `dispatch:gone-${index}`)
      h.delivery.withdrawStale(gone)
      h.delivery.withdrawStale(gone)
      await flush()
      expect(retained(h)).toBe(0)
      expect(h.host.observe).not.toHaveBeenCalled()
    }
  )

  it('keeps a cleanup that races a settle, then forgets the mailbox once nothing of it is left', async () => {
    const h = harness({ busy: true })
    h.receive('m1')
    await h.deliver()
    expect(h.records.size).toBe(1)
    // The card still waits in the chat: the lane remembers the mailbox.
    expect(retained(h)).toBeGreaterThan(0)
    let answer!: () => void
    vi.mocked(h.host.observe).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = () => resolve({ kind: 'absent' })
        })
    )
    h.end()
    h.delivery.withdrawStale(['dispatch:d1'])
    await flush()
    // Mid-settle, the record goes and another cleanup finds nothing: its mark is kept for the pass.
    h.records.clear()
    h.delivery.withdrawStale(['dispatch:d1'])
    expect(h.delivery['settledState']['changes'].get('dispatch:d1')).toBe(2)
    answer()
    await flush()
    expect(retained(h)).toBe(0)
  })
})

describe('structured mailbox delivery across a real database close and reopen', () => {
  it.each([
    ['still waits as a card', { kind: 'waiting' }, true, 0],
    ['was handed over while Orca was down', { kind: 'accepted' }, true, 0],
    // Reserved, then Orca stopped before the host call: the same id is admitted.
    ['was reserved but never admitted', { kind: 'absent' }, true, 1],
    // Admitted, then Orca stopped before an older build stamped it: never sent again.
    ['was admitted before an older build stamped it', { kind: 'unknown' }, false, 0],
    ['was handed over before an older build stamped it', { kind: 'accepted' }, false, 0]
  ] as const)('settles a send that %s', async (_label, state, stamped, sends) => {
    // Orca reopens a minute after the send was recorded, well inside the host's admission window.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_757_030_460_000)
    const directory = mkdtempSync(join(tmpdir(), 'orca-structured-mail-reopen-'))
    const file = join(directory, 'orchestration.db')
    let db = new OrchestrationDb(file)
    try {
      const run = db.createRun({
        objective: 'recovery',
        coordinatorHandle: 'term_coord',
        coordinatorPaneKey: 'tab_coord:11111111-1111-4111-8111-111111111111'
      })
      const mailbox = `run:${run.id}`
      const message = db.insertMessage({
        runId: run.id,
        from: 'term_worker',
        to: mailbox,
        subject: 'report'
      })
      const operationId = '1757030400000-0123456789abcdef0123456789abcdef'
      const row = {
        mailbox_handle: mailbox,
        message_id: message.id,
        session_id: 'session-1',
        operation_id: operationId,
        minted_at_ms: 1_757_030_400_000
      }
      if (stamped) {
        expect(db.reserveStructuredMailSend(row)).toBe(true)
      } else {
        db.db
          .prepare(
            `INSERT INTO structured_mail_sends
               (mailbox_handle, message_id, session_id, operation_id, minted_at_ms)
             VALUES (?, ?, ?, ?, ?)`
          )
          .run(mailbox, message.id, 'session-1', operationId, row.minted_at_ms)
      }
      expect(db.getMessageById(message.id)?.read).toBe(0)
      db.close()
      db = new OrchestrationDb(file)
      const reopened = db
      const send = vi.fn(async (_input: { operationId: string }) => ({ kind: 'queued' as const }))
      const delivery = new OrchestrationStructuredMailboxPointerDelivery({
        getDb: () => reopened,
        getMessageWaiters: () => undefined,
        resolveStructuredTarget: () => ({ sessionId: 'session-1', dispatchId: null }),
        mailboxEnded: () => false,
        getCliCommand: () => 'orca-dev',
        senderSnapshot: () => ({ name: null, agent: null }),
        host: {
          currentFence: () => 4,
          watchJournal: () => () => {},
          observe: async () => state,
          wakeQueue: () => {},
          withdraw: async () => true,
          send
        }
      })
      // The restore scan schedules every mailbox with a send on record.
      for (const handle of db.getStructuredMailSendMailboxes()) {
        delivery.deliverForHandle(handle)
      }
      await flush()
      expect(send).toHaveBeenCalledTimes(sends)
      if (sends > 0) {
        // Never admitted: the same id is admitted, so the host's own replay protection holds.
        expect(send.mock.calls[0]?.[0]).toMatchObject({ operationId })
      }
      const settled = db.getMessageById(message.id)
      expect(settled?.read).toBe(state.kind === 'accepted' ? 1 : 0)
      // Whatever it became, the message is never selectable for another send.
      expect(settled?.delivered_at).not.toBeNull()
      const retired = state.kind === 'accepted' || state.kind === 'unknown'
      expect(db.getStructuredMailSends(mailbox)).toHaveLength(retired ? 0 : 1)
    } finally {
      db.close()
      rmSync(directory, { recursive: true, force: true })
      vi.useRealTimers()
    }
  })
})

describe('parked mailboxes and their journal watches', () => {
  it.each([4, 40])(
    'wakes one of %i chats with only its own mail, and ends its watch with it',
    (count) => {
      const unwatched: string[] = []
      const callbacks = new Map<string, () => void>()
      const woken: string[] = []
      const parking = new StructuredMailboxParking({
        watchJournal: (sessionId, onActivity) => {
          callbacks.set(sessionId, onActivity)
          return () => unwatched.push(sessionId)
        },
        onActivity: (sessionId) => {
          woken.push(...parking.parkedFor(sessionId).map(([mailbox]) => mailbox))
        }
      })
      for (let chat = 0; chat < count; chat += 1) {
        parking.park(`dispatch:${chat}`, `session-${chat}`)
      }
      callbacks.get('session-1')!()
      expect(woken).toEqual(['dispatch:1'])
      // The last mailbox leaving ends the watch at once, with no further journal write.
      parking.unpark('dispatch:1')
      expect(unwatched).toEqual(['session-1'])
      // A mailbox that moves to another chat leaves its old chat's watch behind.
      parking.park('dispatch:2', 'session-3')
      expect(unwatched).toEqual(['session-1', 'session-2'])
      expect(parking.parkedFor('session-3').map(([mailbox]) => mailbox)).toEqual([
        'dispatch:3',
        'dispatch:2'
      ])
    }
  )
})
