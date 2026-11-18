import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { fixture, groupNativeMocks } from './bot-group-native-runtime.test-fixture'
import { BotGroupStore } from './bot-group-store'
import { assertBotGroupOwner } from '../runtime/rpc/methods/bot-groups'
import { assertBotGroupSessionAccess } from './bot-group-session-access'
import type { StructuredMailboxPointerHost } from '../runtime/orchestration/mailbox/structured-pointer/structured-mailbox-pointer-host-contract'
const mocks = groupNativeMocks()
describe('persistent native group lifecycle', () => {
  it('creates a separate persistent native session for each group member and reserves ordered responders', async () => {
    const { groups } = fixture()
    const group = await groups.create({ name: 'Review', botIds: ['bot-0', 'bot-1', 'bot-2'] })
    expect(new Set(group.members.map((member) => member.sessionId)).size).toBe(3)
    expect(group.members.every((member) => member.sessionId.startsWith('bot-group-member-'))).toBe(
      true
    )
    const updated = await groups.update({
      groupId: group.id,
      revision: group.revision,
      replyMode: { kind: 'all' }
    })
    const input = {
      groupId: group.id,
      revision: updated.revision,
      messageId: randomUUID(),
      text: 'Compare plans without tools.'
    }
    const message = await groups.send(input)
    expect(message.turns.map((turn) => turn.botId)).toEqual(['bot-0', 'bot-1', 'bot-2'])
    expect(message.turns.map((turn) => groups.store.pendingContext(turn.operationId))).toEqual([
      '[]',
      '[]',
      '[]'
    ])
    expect(groups.store.message(message.id)?.turns).toEqual(message.turns)
    await groups.send(input)
    expect(groups.store.messages(group.id)).toHaveLength(1)
    await expect(groups.send({ ...input, text: 'different' })).rejects.toThrow(/identity/)
  })
  it('records a peer status as told, not asked, for the room and the next turn', async () => {
    const { groups, mails, requests } = fixture()
    const group = await groups.create({ name: 'Review', botIds: ['bot-0', 'bot-1'] })
    const [source, target] = group.members
    mails.set('fyi', { id: 'fyi', from_handle: source.sessionId, thread_id: null, type: 'status' })
    requests.set('fyi', {
      record: JSON.stringify({
        group: {
          id: group.id,
          rootRequestId: 'human',
          rootSequence: 1,
          sourceSessionId: source.sessionId,
          targetSessionId: target.sessionId
        }
      })
    })
    groups.reserveMailTurn({
      sessionId: target.sessionId,
      dispatchId: null,
      operationId: 'fyi-op',
      expectedRuntimeFence: 1,
      stillOwed: () => true,
      body: {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: 'status' }],
        from: {
          kind: 'agent',
          senders: [],
          orchestration: {
            message: 'mail-notice',
            mailbox: target.sessionId,
            dispatchId: null,
            messages: [{ messageId: 'fyi', runId: 'run', from: source.sessionId }]
          }
        }
      }
    })
    const told = groups.store.message('mail:fyi-op')
    expect(told?.requester).toEqual({ id: 'bot-0', name: 'Scout', told: true })
    expect(told?.text).toBe('Scout told Forge')
  })
  it('fences durable peer continuations after removal and verifies the actual worker sender', async () => {
    const { groups, mails, requests } = fixture()
    let group = await groups.create({ name: 'Review', botIds: ['bot-0', 'bot-1'] })
    const [source, target] = group.members
    mails.set('peer', { id: 'peer', from_handle: source.sessionId, thread_id: null })
    requests.set('peer', {
      record: JSON.stringify({
        group: {
          id: group.id,
          rootRequestId: 'human',
          rootSequence: 1,
          sourceSessionId: source.sessionId,
          targetSessionId: target.sessionId
        }
      })
    })
    const input: Parameters<StructuredMailboxPointerHost['send']>[0] = {
      sessionId: target.sessionId,
      dispatchId: null,
      operationId: 'mail-op',
      expectedRuntimeFence: 1,
      stillOwed: () => true,
      body: {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: 'peer request' }],
        from: {
          kind: 'agent',
          senders: [],
          orchestration: {
            message: 'mail-notice',
            mailbox: target.sessionId,
            dispatchId: null,
            messages: [{ messageId: 'peer', runId: 'run', from: source.sessionId }]
          }
        }
      }
    }
    groups.reserveMailTurn(input)
    groups.reserveMailTurn(input)
    expect(groups.store.messages(group.id)).toHaveLength(1)
    expect(groups.store.messages(group.id)[0].author).toMatchObject({
      kind: 'bot',
      id: target.botId
    })
    expect(groups.store.messages(group.id)[0].requester).toEqual({ id: 'bot-0', name: 'Scout' })
    // The peer's reply comes back on the request's thread, as the asker's follow-up turn.
    mails.set('reply', { id: 'reply', from_handle: target.sessionId, thread_id: 'peer' })
    groups.reserveMailTurn({
      ...input,
      sessionId: source.sessionId,
      operationId: 'reply-op',
      body: {
        ...input.body,
        from: {
          kind: 'agent',
          senders: [],
          orchestration: {
            message: 'mail-notice',
            mailbox: source.sessionId,
            dispatchId: null,
            messages: [{ messageId: 'reply', runId: 'run', from: target.sessionId }]
          }
        }
      }
    })
    const reply = groups.store.message('mail:reply-op')
    expect(reply?.requester).toBeUndefined()
    expect(reply?.answeredBy).toEqual({ id: 'bot-1', name: 'Forge' })
    expect(reply?.text).toBe("Scout read Forge's reply")
    group = await groups.update({
      groupId: group.id,
      revision: group.revision,
      botIds: [target.botId]
    })
    expect(() => groups.reserveMailTurn({ ...input, operationId: 'stale-mail' })).toThrow(
      /outside the active group/
    )
    mails.set('peer', { id: 'peer', from_handle: 'unverified-worker', thread_id: null })
    requests.clear()
    expect(() => groups.reserveMailTurn({ ...input, operationId: 'forged-worker' })).toThrow(
      /outside the active group/
    )
    const work = await groups.send({
      groupId: group.id,
      revision: group.revision,
      messageId: randomUUID(),
      text: '@Forge start a worker'
    })
    groups.store.bindWorker('owned-worker', work.turns[0].operationId)
    mails.set('peer', { id: 'peer', from_handle: 'dispatch:owned-worker', thread_id: null })
    groups.reserveMailTurn({ ...input, operationId: 'verified-worker' })
    expect(groups.store.messages(group.id)).toHaveLength(4)
    expect(groups.store.message('mail:verified-worker')).toMatchObject({
      rootRequestId: work.id,
      rootSequence: work.sequence
    })
    expect(groups.store.message('mail:verified-worker')?.requester).toBeUndefined()
  })
  it('scopes Stop to room native sessions and invalidates older causal requests', async () => {
    const { groups } = fixture()
    const group = await groups.create({ name: 'Review', botIds: ['bot-0', 'bot-1'] })
    await groups.send({
      groupId: group.id,
      revision: group.revision,
      messageId: 'human',
      text: '@everyone harmless'
    })
    await groups.stop(group.id, 'bot-0')
    expect(mocks.cancel.mock.calls.map((call) => call[1].envelope.sessionId)).toEqual([
      group.members[0].sessionId
    ])
    const current = groups.store.get(group.id)
    expect(current.members[0].stoppedThroughSequence).toBeGreaterThan(0)
    expect(current.members[1].stoppedThroughSequence).toBeUndefined()
    await groups.stop(group.id)
    expect(mocks.cancel.mock.calls.slice(1).map((call) => call[1].envelope.sessionId)).toEqual(
      group.members.map((member) => member.sessionId)
    )
  })
  it('persists mentions-only posts without starting a provider and refuses stale membership sends', async () => {
    const { groups, db } = fixture()
    let group = await groups.create({ name: 'Review', botIds: ['bot-0', 'bot-1'] })
    group = await groups.update({
      groupId: group.id,
      revision: group.revision,
      replyMode: { kind: 'mentions' }
    })
    const message = await groups.send({
      groupId: group.id,
      revision: group.revision,
      messageId: randomUUID(),
      text: 'Room note'
    })
    expect(message.turns).toEqual([])
    expect(mocks.send).not.toHaveBeenCalled()
    const restored = new BotGroupStore(db)
    expect(restored.get(group.id)).toEqual(group)
    expect(restored.messages(group.id)).toEqual([message])
    await groups.update({ groupId: group.id, revision: group.revision, botIds: ['bot-1'] })
    await expect(
      groups.send({
        groupId: group.id,
        revision: group.revision,
        messageId: randomUUID(),
        text: '@Scout hello'
      })
    ).rejects.toThrow(/changed/)
  })
  it('removes the default explicitly, retains history and fences delayed delivery after removal', async () => {
    const { groups } = fixture()
    const group = await groups.create({ name: 'Review', botIds: ['bot-0', 'bot-1'] })
    let guard: (() => void) | undefined
    mocks.send.mockImplementation(async (send) => {
      guard = send.turn.beforeRun
      return { kind: 'sent' }
    })
    const message = await groups.send({
      groupId: group.id,
      revision: group.revision,
      messageId: randomUUID(),
      text: 'hello'
    })
    await vi.waitFor(() => expect(guard).toBeTypeOf('function'))
    const saved = await groups.update({
      groupId: group.id,
      revision: group.revision,
      botIds: ['bot-1']
    })
    expect(saved.replyMode).toEqual({ kind: 'mentions' })
    expect(groups.store.message(message.id)?.text).toBe('hello')
    expect(groups.store.message(message.id)?.turns[0].revoked).toBe(true)
    expect(() => guard?.()).toThrow(/member/)
    mocks.snapshot.mockClear()
    await groups.send({
      groupId: group.id,
      revision: saved.revision,
      messageId: randomUUID(),
      text: '@Forge continue'
    })
    expect(mocks.snapshot.mock.calls.some(([id]) => id === group.members[0].sessionId)).toBe(false)
    const rejoined = await groups.update({
      groupId: group.id,
      revision: saved.revision,
      botIds: ['bot-0', 'bot-1']
    })
    expect(rejoined.members[0].sessionId).not.toBe(group.members[0].sessionId)
  })
  it('blocks model-written human messages and model approval access to another group member', async () => {
    const { runtime, groups } = fixture()
    const group = await groups.create({ name: 'Review', botIds: ['bot-0'] })
    expect(() =>
      assertBotGroupSessionAccess(runtime, group.members[0].sessionId, { kind: 'local-cli' })
    ).toThrow(/human/)
    expect(() =>
      assertBotGroupSessionAccess(runtime, 'bot-group-member-archived', { kind: 'desktop' }, true)
    ).not.toThrow()
    expect(() =>
      assertBotGroupSessionAccess(runtime, 'bot-group-member-archived', { kind: 'local-cli' }, true)
    ).toThrow(/human/)
    expect(() =>
      assertBotGroupSessionAccess(runtime, 'bot-group-member-archived', { kind: 'desktop' })
    ).toThrow(/no longer/)
    expect(() => assertBotGroupOwner({ caller: { kind: 'local-cli' } })).toThrow(/human owner/)
  })
})
