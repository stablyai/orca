import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { BotGroupMessage } from '../../shared/bots/bot-group'
import type { StructuredMailboxPointerHost } from '../runtime/orchestration/mailbox/structured-pointer/structured-mailbox-pointer-host-contract'
import { OrchestrationStructuredMailboxPointerDelivery } from '../runtime/orchestration/mailbox/structured-pointer/structured-mailbox-pointer-delivery'
import { fixture, groupNativeMocks } from './bot-group-native-runtime.test-fixture'
import { BOT_GROUP_MAIL_NEVER_STARTED } from './bot-group-dead-mail-turns'

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
    expect(groups.store.operationMessage('first')?.rootRequestId).toBe(roots[0].id)
    expect(ids(groups.narrowMailBatch(target.sessionId, [row('peer-1')]))).toEqual(['peer-1'])
    groups.reserveMailTurn(notice('second', ['peer-1']))
    expect(groups.store.operationMessage('second')?.rootRequestId).toBe(roots[1].id)
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
    expect(groups.store.operationMessage(input.operationId)?.rootRequestId).toBe(live.id)
  })

  it('keeps one mail line on the attempt that runs when the lane retries under a new id', async () => {
    const { groups, group, notice } = await room(1)
    groups.reserveMailTurn(notice('refused', ['peer-0']))
    // The host refused that id, which would only replay its refusal: the lane mints another.
    groups.reserveMailTurn(notice('retried', ['peer-0']))
    const lines = groups.store.messages(group.id).filter((message) => message.turns[0]?.mailbox)
    expect(lines.map((line) => line.turns.map((turn) => turn.operationId))).toEqual([['retried']])
    expect(groups.store.operationMessage('retried')?.id).toBe(lines[0].id)
  })

  it('settles a mail turn nothing holds or owes any more, and leaves the others alone', async () => {
    const { groups, group, notice, heldSends, mails } = await room(4)
    const { sendAnswer } = groupNativeMocks()
    groups.reserveMailTurn(notice('dead', ['peer-0']))
    groups.reserveMailTurn(notice('in-lane', ['peer-1']))
    groups.reserveMailTurn(notice('queued', ['peer-2']))
    groups.reserveMailTurn(notice('parked', ['peer-3']))
    heldSends.add('in-lane')
    // Refused and parked for the chat's next edge: its mail is still unread, so still owed.
    mails.set('peer-3', { ...mails.get('peer-3')!, read: 0 })
    sendAnswer.mockImplementation(async (_sessionId: string, operationId: string) => ({
      kind: operationId === 'queued' ? 'waiting' : 'refused'
    }))
    const error = (operationId: string) =>
      groups.store.operationMessage(operationId)?.turns[0]?.error
    groups.read(group.id)
    await vi.waitFor(() => expect(error('dead')).toBe(BOT_GROUP_MAIL_NEVER_STARTED))
    for (const operationId of ['in-lane', 'parked']) {
      expect(sendAnswer).not.toHaveBeenCalledWith(expect.anything(), operationId)
      expect(error(operationId)).toBeUndefined()
    }
    expect(error('queued')).toBeUndefined()
    // The mail's next attempt takes the same line back from its settled state.
    const dead = groups.store.operationMessage('dead')!
    groups.reserveMailTurn(notice('next', ['peer-0']))
    const next = groups.store.operationMessage('next')
    expect(next?.id).toBe(dead.id)
    expect(next?.turns[0]).not.toHaveProperty('error')
  })

  it('gives mail back after its turn ran a line of its own, which then follows retries', async () => {
    const { groups, notice } = await room(1)
    groups.reserveMailTurn(notice('ran', ['peer-0']))
    const ran = groups.store.operationMessage('ran')!
    groups.store.update({ ...ran, turns: ran.turns.map((turn) => ({ ...turn, reply: 'done' })) })
    groups.reserveMailTurn(notice('again', ['peer-0']))
    groups.reserveMailTurn(notice('again-retried', ['peer-0']))
    expect(groups.store.operationMessage('ran')?.turns[0]?.operationId).toBe('ran')
    const again = groups.store.operationMessage('again-retried')
    expect(again?.id).not.toBe(ran.id)
    expect(again?.turns.map((turn) => turn.operationId)).toEqual(['again-retried'])
  })

  it('takes a resend of a line saved under its operation id without a second line', async () => {
    const { groups, group, notice } = await room(2)
    groups.reserveMailTurn(notice('template', ['peer-1']))
    const { sequence: _sequence, ...template } = groups.store.operationMessage('template')!
    // As builds before lines were keyed by mail saved one: `mail:<operation id>`.
    groups.store.append({
      ...template,
      id: 'mail:legacy',
      turns: template.turns.map((turn) => ({ ...turn, operationId: 'legacy' }))
    })
    expect(() => groups.reserveMailTurn(notice('legacy', ['peer-0']))).not.toThrow()
    const lines = groups.store.messages(group.id).filter((message) => message.turns[0]?.mailbox)
    expect(lines.map((line) => line.id)).toEqual([template.id, 'mail:legacy'])
  })

  it('holds a worker report that arrives before its worker is recorded', async () => {
    const { groups, target, startWorker } = await room(1)
    const early = startWorker('term_w1').send(target.sessionId, 'status')
    expect(groups.narrowMailBatch(target.sessionId, [early])).toEqual({ messages: [], ended: [] })
  })

  it("wakes the member with its worker's final report after the worker's Dispatch settles", async () => {
    const { groups, orchestration, source, roots, startWorker } = await room(1)
    const [turn] = roots[0].turns
    const worker = startWorker('term_worker')
    groups.store.bindWorker(worker.dispatchId, turn.operationId)
    const done = worker.send(source.sessionId, 'worker_done')
    orchestration.completeDispatch(worker.dispatchId)
    expect(groups.narrowMailBatch(source.sessionId, [done])).toEqual({
      messages: [done],
      ended: []
    })
  })
})
