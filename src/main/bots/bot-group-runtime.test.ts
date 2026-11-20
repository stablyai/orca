import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { AgentSessionAttachmentStore } from '../native-chat/agent-session-attachments/agent-session-attachment-store'
import { setAgentSessionAttachmentStore } from '../native-chat/agent-session-attachments/agent-session-attachment-store-registry'
import { fixture, groupNativeMocks } from './bot-group-native-runtime.test-fixture'
import { BotGroupRuntime } from './bot-group-runtime'
import { BotGroupStore } from './bot-group-store'
import { assertBotGroupOwner } from '../runtime/rpc/methods/bot-groups'
import { assertBotGroupSessionAccess } from './bot-group-session-access'
import type { StructuredMailboxPointerHost } from '../runtime/orchestration/mailbox/structured-pointer/structured-mailbox-pointer-host-contract'
const mocks = groupNativeMocks()
describe('persistent native group lifecycle', () => {
  it('creates separate member sessions, admits ordered responders and does not redeliver a replay', async () => {
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
    await vi.waitFor(() => expect(groups.store.pending()).toEqual([]))
    for (const turn of message.turns) {
      expect(() =>
        groups.assertQueuedMessageAllowed(turn.sessionId, turn.operationId)
      ).not.toThrow()
    }
    await groups.send(input)
    expect(mocks.send).toHaveBeenCalledTimes(3)
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
    const told = groups.store.operationMessage('fyi-op')
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
    const reply = groups.store.operationMessage('reply-op')
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
    mails.set('report', { id: 'report', from_handle: 'dispatch:owned-worker', thread_id: null })
    groups.reserveMailTurn({
      ...input,
      operationId: 'verified-worker',
      body: {
        ...input.body,
        from: {
          kind: 'agent',
          senders: [],
          orchestration: {
            message: 'mail-notice',
            mailbox: target.sessionId,
            dispatchId: null,
            messages: [{ messageId: 'report', runId: 'run', from: 'dispatch:owned-worker' }]
          }
        }
      }
    })
    expect(groups.store.messages(group.id)).toHaveLength(4)
    expect(groups.store.operationMessage('verified-worker')).toMatchObject({
      rootRequestId: work.id,
      rootSequence: work.sequence
    })
    expect(groups.store.operationMessage('verified-worker')?.requester).toBeUndefined()
  })
  it('scopes Stop to room sessions and preserves the cutoff after runtime recreation', async () => {
    const { groups, runtime } = fixture()
    const group = await groups.create({ name: 'Review', botIds: ['bot-0', 'bot-1'] })
    const message = await groups.send({
      groupId: group.id,
      revision: group.revision,
      messageId: 'human',
      text: '@everyone harmless'
    })
    const [turn] = message.turns
    const restored = new BotGroupRuntime(runtime)
    expect(() =>
      restored.assertQueuedMessageAllowed(turn.sessionId, turn.operationId)
    ).not.toThrow()
    expect(() =>
      restored.assertQueuedMessageAllowed(group.members[1].sessionId, turn.operationId)
    ).toThrow(/cannot be verified/)
    expect(() => restored.assertQueuedMessageAllowed('ordinary-home', 'unrelated')).not.toThrow()

    await restored.stop(group.id, 'bot-0')
    expect(() =>
      new BotGroupRuntime(runtime).assertQueuedMessageAllowed(turn.sessionId, turn.operationId)
    ).toThrow(/no longer active/)
    expect(groups.store.message(message.id)?.turns[0].error).toMatch(/no longer active/)
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
  it('rejects retired deliveries after a member rejoins with a new session', async () => {
    const { groups, runtime } = fixture()
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
    const [retired] = message.turns
    expect(() =>
      new BotGroupRuntime(runtime).assertQueuedMessageAllowed(
        retired.sessionId,
        retired.operationId
      )
    ).toThrow(/no longer active/)
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
  it('claims a dropped image for every member and delivers it as an image block', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orca-bot-group-images-'))
    const store = new AgentSessionAttachmentStore(join(dir, 'agent-session-attachments'), {
      hasSession: () => true
    })
    const claimed: string[] = []
    setAgentSessionAttachmentStore(store, async (sessionId) => {
      claimed.push(sessionId)
    })
    try {
      const { groups } = fixture()
      const group = await groups.create({ name: 'Review', botIds: ['bot-0', 'bot-1'] })
      const dropped = join(dir, 'shot.png')
      await writeFile(dropped, Buffer.alloc(12))

      const sent = await groups.send(
        {
          groupId: group.id,
          revision: group.revision,
          messageId: randomUUID(),
          text: '@Forge [Image #1]',
          images: [dropped]
        },
        { local: true }
      )
      const stored = sent.images![0].path
      expect(sent.images).toEqual([
        {
          path: expect.stringMatching(/agent-session-attachments[\\/][0-9a-f-]{36}[\\/]shot\.png$/),
          name: 'shot.png',
          bytes: 12
        }
      ])
      expect(claimed).toEqual(group.members.map((member) => member.sessionId))
      await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(1))
      expect(mocks.send.mock.calls[0][0].sessionId).toBe(group.members[1].sessionId)
      expect(mocks.send.mock.calls[0][0].turn.body.blocks.slice(1)).toEqual([
        { type: 'image-ref', path: stored }
      ])
    } finally {
      setAgentSessionAttachmentStore(null)
      await rm(dir, { recursive: true, force: true })
    }
  })
})
