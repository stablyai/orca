import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { BotGroupMessage } from '../../shared/bots/bot-group'
import type { StructuredMailboxPointerHost } from '../runtime/orchestration/mailbox/structured-pointer/structured-mailbox-pointer-host-contract'
import { OrchestrationStructuredMailboxPointerDelivery } from '../runtime/orchestration/mailbox/structured-pointer/structured-mailbox-pointer-delivery'
import { fixture } from './bot-group-native-runtime.test-fixture'

/** Two members, a peer request mailed from Scout to Forge for each human post given. */
async function room(posts: number) {
  const setup = fixture()
  const { groups, mails, requests } = setup
  let group = await groups.create({ name: 'Review', botIds: ['bot-0', 'bot-1'] })
  const [source, target] = group.members
  const roots: BotGroupMessage[] = []
  for (let index = 0; index < posts; index += 1) {
    const post = await groups.send({
      groupId: group.id,
      revision: group.revision,
      messageId: randomUUID(),
      text: `@Scout post ${index}`
    })
    group = groups.store.get(group.id)
    roots.push(post)
  }
  const row = (id: string) => ({ id, thread_id: null, from_handle: source.sessionId })
  /** A peer request from Scout to Forge under this post. */
  const peer = (id: string, post: BotGroupMessage) => {
    mails.set(id, row(id))
    requests.set(id, {
      record: JSON.stringify({
        group: {
          id: group.id,
          rootRequestId: post.id,
          rootSequence: post.sequence,
          sourceSessionId: source.sessionId,
          targetSessionId: target.sessionId
        }
      })
    })
  }
  const notice = (operationId: string, ids: readonly string[]) =>
    ({
      sessionId: target.sessionId,
      dispatchId: null,
      operationId,
      expectedRuntimeFence: 1,
      stillOwed: () => true,
      body: {
        kind: 'message',
        role: 'user',
        blocks: [],
        from: {
          kind: 'agent',
          senders: [],
          orchestration: {
            message: 'mail-notice',
            mailbox: target.sessionId,
            dispatchId: null,
            messages: ids.map((messageId) => ({ messageId, runId: 'run', from: source.sessionId }))
          }
        }
      }
    }) satisfies Parameters<StructuredMailboxPointerHost['send']>[0]
  roots.forEach((post, index) => peer(`peer-${index}`, post))
  return { ...setup, group, source, target, roots, row, peer, notice }
}

describe('group mail roots', () => {
  const ids = (batch: { messages: { id: string }[] }) => batch.messages.map((mail) => mail.id)

  it('carries one root per notice when two roots wait behind one approval', async () => {
    const { groups, target, roots, row, notice } = await room(2)
    expect(ids(groups.narrowMailBatch(target.sessionId, [row('peer-1'), row('peer-0')]))).toEqual([
      'peer-0'
    ])
    groups.reserveMailTurn(notice('first', ['peer-0']))
    expect(groups.store.message('mail:first')?.rootRequestId).toBe(roots[0].id)
    expect(ids(groups.narrowMailBatch(target.sessionId, [row('peer-1')]))).toEqual(['peer-1'])
    groups.reserveMailTurn(notice('second', ['peer-1']))
    expect(groups.store.message('mail:second')?.rootRequestId).toBe(roots[1].id)
    expect(() => groups.reserveMailTurn(notice('mixed', ['peer-0', 'peer-1']))).toThrow(
      /outside the active group/
    )
  })

  it('retires a full page of stopped mail and reserves the live root behind it', async () => {
    const { groups, group, target, row, peer, roots } = await room(1)
    for (let index = 0; index < 50; index += 1) {
      peer(`stopped-${index}`, roots[0])
    }
    await groups.stop(group.id)
    const live = await groups.send({
      groupId: group.id,
      revision: groups.store.get(group.id).revision,
      messageId: randomUUID(),
      text: '@Scout after the stop'
    })
    peer('mail-51', live)
    const inbox = [
      ...Array.from({ length: 50 }, (_, index) => row(`stopped-${index}`)),
      row('mail-51')
    ].map((mail, index) => ({
      ...mail,
      type: 'status',
      sequence: index,
      run_id: 'run',
      to_handle: 'mailbox',
      subject: mail.id,
      body: mail.id,
      payload: null,
      priority: 'normal',
      delivery_contract: 'standard',
      read: 0,
      delivered_at: null
    }))
    const delivered = new Set<string>()
    const send = vi.fn<StructuredMailboxPointerHost['send']>(async () => ({
      kind: 'sent',
      state: 'accepted'
    }))
    const sends = new Map<string, { message_id: string; operation_id: string }>()
    const db = {
      getRun: () => undefined,
      getDispatchContextById: () => undefined,
      getOutstandingMailboxDelivery: () => undefined,
      isPeerMailSenderLabel: () => false,
      getUndeliveredUnreadMessages: (_handle: string, _filter: unknown, input: { limit: number }) =>
        inbox.filter((mail) => !delivered.has(mail.id)).slice(0, input.limit),
      areUnreadMessages: () => true,
      getMessageById: (id: string) => inbox.find((mail) => mail.id === id),
      markAsDelivered: (marked: string[]) => marked.forEach((id) => delivered.add(id)),
      getStructuredMailSends: () => [...sends.values()],
      getStructuredMailSend: (_handle: string, id: string) => sends.get(id),
      hasStructuredMailSend: () => sends.size > 0,
      reserveStructuredMailSend: (send: { message_id: string; operation_id: string }) => {
        sends.set(send.message_id, send)
        delivered.add(send.message_id)
        return true
      },
      retireStructuredMailSend: (send: { message_id: string }) => sends.delete(send.message_id)
    }
    const delivery = new OrchestrationStructuredMailboxPointerDelivery({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stub implements every database read this delivery path makes.
      getDb: () => db as never,
      getMessageWaiters: () => undefined,
      resolveStructuredTarget: () => ({ sessionId: target.sessionId, dispatchId: null }),
      getCliCommand: () => 'orca-dev',
      senderSnapshot: () => ({ name: null, agent: null }),
      host: {
        currentFence: () => 1,
        watchJournal: () => () => {},
        send,
        observe: async () => ({ kind: 'absent' }),
        wakeQueue: () => {},
        withdraw: async () => ({ kind: 'withdrawn' }),
        narrowBatch: (sessionId, messages) => groups.narrowMailBatch(sessionId, messages)
      }
    })
    delivery.deliverForHandle('mailbox')
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    const input = send.mock.calls[0][0]
    const sent = input.body.from?.orchestration
    expect(sent?.message === 'mail-notice' && sent.messages.map((mail) => mail.messageId)).toEqual([
      'mail-51'
    ])
    expect(delivered).toEqual(new Set(inbox.map((mail) => mail.id)))
    groups.reserveMailTurn(input)
    expect(groups.store.message(`mail:${input.operationId}`)?.rootRequestId).toBe(live.id)
  })

  it('holds a worker report that arrives before its worker is recorded', async () => {
    const { groups, target, row } = await room(1)
    const early = { ...row('early'), from_handle: 'dispatch:w1' }
    expect(groups.narrowMailBatch(target.sessionId, [early])).toEqual({ messages: [], ended: [] })
  })
})
