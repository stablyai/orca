import { describe, expect, it, vi } from 'vitest'
import { OrchestrationStructuredMailboxPointerDelivery } from './structured-mailbox-pointer-delivery'
import type {
  StructuredMailboxPointerHost,
  StructuredMailSendState
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

/** One chat session behind dispatch:d1: idle sends start a turn, busy ones wait as cards. */
function harness(options: { busy?: boolean; refuse?: boolean } = {}) {
  const mailbox = 'dispatch:d1'
  const mail = new Map<string, Mail>()
  const records = new Map<string, StructuredMailSendRow>()
  let busy = options.busy ?? false
  let refuse = options.refuse ?? false
  /** What the chat holds per operation id: a waiting card, or what its handoff became. */
  const chat = new Map<string, StructuredMailSendState>()
  const texts: string[] = []
  const db = {
    getRun: () => undefined,
    getDispatchContextById: () => ({ run_id: 'run_1' }),
    getOutstandingMailboxDelivery: () => undefined,
    getUndeliveredUnreadMessages: (handle: string) =>
      [...mail.values()].filter(
        (row) => row.to_handle === handle && !row.read && row.delivered_at === null
      ),
    areUnreadMessages: (_handle: string, ids: string[]) =>
      ids.every((id) => mail.get(id)?.read === 0),
    getMessageById: (id: string) => mail.get(id),
    markAsDelivered: (ids: string[]) => {
      for (const id of ids) {
        mail.get(id)!.delivered_at ??= 'now'
      }
    },
    markAsReadAndDelivered: (ids: string[]) => {
      for (const id of ids) {
        Object.assign(mail.get(id)!, { read: 1, delivered_at: 'now' })
      }
    },
    getStructuredMailSends: (handle: string) =>
      [...records.values()].filter((row) => row.mailbox_handle === handle),
    getTakenStructuredMailSends: () =>
      [...records.values()].filter((row) => {
        const message = mail.get(row.message_id)
        return !message || message.read === 1 || message.to_handle !== row.mailbox_handle
      }),
    putStructuredMailSend: (row: StructuredMailSendRow) => records.set(row.message_id, row),
    deleteStructuredMailSend: (_handle: string, id: string) => records.delete(id)
  }
  const host: StructuredMailboxPointerHost = {
    currentFence: () => 4,
    send: vi.fn(async (input) => {
      if (!input.stillOwed()) {
        return { kind: 'obsolete' as const }
      }
      if (refuse) {
        return { kind: 'refused' as const }
      }
      texts.push(input.body.blocks.map((block) => ('text' in block ? block.text : '')).join(''))
      chat.set(input.operationId, busy ? 'waiting' : 'handed')
      return busy
        ? { kind: 'queued' as const }
        : { kind: 'sent' as const, state: 'accepted' as const }
    }),
    observe: vi.fn(async (_sessionId, operationId) => chat.get(operationId) ?? 'absent'),
    withdraw: vi.fn(async (_sessionId, operationId) => {
      chat.delete(operationId)
      return true
    })
  }
  const delivery = new OrchestrationStructuredMailboxPointerDelivery({
    getDb: () => db as never,
    getMessageWaiters: () => undefined,
    resolveStructuredTarget: (handle) =>
      handle === mailbox ? { sessionId: 'session-1', dispatchId: 'd1' } : null,
    getCliCommand: () => 'orca-dev',
    senderSnapshot: () => ({ name: 'Coordinator', agent: null }),
    host
  })
  let sequence = 0
  return {
    delivery,
    host,
    mail,
    records,
    chat,
    texts,
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
    /** The agent was handed the card waiting under this message's operation id. */
    handOver: (id: string) => chat.set(records.get(id)!.operation_id, 'handed'),
    setBusy: (next: boolean) => {
      busy = next
    },
    setRefuse: (next: boolean) => {
      refuse = next
    }
  }
}

const flush = async () => {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

describe('structured mailbox delivery: each message whole', () => {
  it('hands an idle chat the whole message and marks it read', async () => {
    const h = harness()
    h.receive('m1', 'Tests pass; PR #12 is ready.')
    await h.deliver()
    expect(h.texts).toHaveLength(1)
    expect(h.texts[0]).toContain('Subject: subject of m1')
    expect(h.texts[0]).toContain('Tests pass; PR #12 is ready.')
    expect(h.texts[0]).toContain('[Reply: orca-dev orchestration reply --id m1')
    expect(h.mail.get('m1')).toMatchObject({ read: 1 })
    expect(h.records.size).toBe(0)
  })

  it('queues each message as its own card while the chat works, reading each on handover', async () => {
    const h = harness({ busy: true })
    h.receive('m1')
    h.receive('m2')
    await h.deliver()
    expect(h.texts).toEqual([
      expect.stringContaining('body of m1'),
      expect.stringContaining('body of m2')
    ])
    // The chat holds both, so check still shows them until the agent is handed each.
    expect(h.mail.get('m1')).toMatchObject({ read: 0, delivered_at: 'now' })
    h.handOver('m1')
    h.delivery.onJournalActivity('session-1')
    await flush()
    expect(h.mail.get('m1')?.read).toBe(1)
    expect(h.mail.get('m2')?.read).toBe(0)
    expect(h.records.has('m2')).toBe(true)
    expect(h.host.send).toHaveBeenCalledTimes(2)
  })

  it('deletes the waiting card when a check takes its message first', async () => {
    const h = harness({ busy: true })
    h.receive('m1')
    await h.deliver()
    const operationId = h.records.get('m1')!.operation_id
    h.mail.get('m1')!.read = 1
    await h.delivery.withdrawTaken()
    expect(h.host.withdraw).toHaveBeenCalledWith('session-1', operationId)
    expect(h.chat.has(operationId)).toBe(false)
    expect(h.records.size).toBe(0)
  })

  it('never sends a message twice when its card already waits after a restart', async () => {
    const h = harness({ busy: true })
    h.receive('m1')
    await h.deliver()
    // A crash before the delivered stamp: the record and the card survive, the stamp does not.
    h.mail.get('m1')!.delivered_at = null
    await h.deliver()
    expect(h.host.send).toHaveBeenCalledTimes(1)
    expect(h.mail.get('m1')?.delivered_at).toBe('now')
  })

  it('sends again under a new id when a recorded send never landed', async () => {
    const h = harness({ busy: true })
    h.receive('m1')
    await h.deliver()
    const first = h.records.get('m1')!.operation_id
    h.chat.delete(first)
    h.mail.get('m1')!.delivered_at = null
    await h.deliver()
    expect(h.host.send).toHaveBeenCalledTimes(2)
    expect(h.records.get('m1')?.operation_id).not.toBe(first)
  })

  it('keeps refused mail unstamped and retries it on the session’s next edge', async () => {
    const h = harness({ refuse: true })
    h.receive('m1')
    await h.deliver()
    expect(h.mail.get('m1')).toMatchObject({ read: 0, delivered_at: null })
    expect(h.records.size).toBe(0)
    h.setRefuse(false)
    h.delivery.onJournalActivity('session-1')
    await flush()
    expect(h.mail.get('m1')?.read).toBe(1)
  })

  it('points a message too large for one chat message at check, leaving it unread', async () => {
    const h = harness()
    h.receive('m1', 'x'.repeat(MAX_PROMPT_BYTES))
    await h.deliver()
    expect(h.texts).toEqual([
      'You have 1 orchestration message. Run `orca-dev orchestration check`.'
    ])
    expect(h.mail.get('m1')).toMatchObject({ read: 0, delivered_at: 'now' })
    expect(h.records.size).toBe(0)
  })
})
