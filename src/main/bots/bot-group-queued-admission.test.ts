import { describe, expect, it, vi } from 'vitest'
import { fixture, groupNativeMocks } from './bot-group-native-runtime.test-fixture'
import { BotGroupRuntime } from './bot-group-runtime'

describe('durable group queued admission', () => {
  it('rechecks persisted generation and Stop cutoffs after the runtime is recreated', async () => {
    const { groups, runtime } = fixture()
    const group = await groups.create({ name: 'Review', botIds: ['bot-0', 'bot-1'] })
    const message = await groups.send({
      groupId: group.id,
      revision: group.revision,
      messageId: 'human',
      text: 'hello'
    })
    const [turn] = message.turns
    const restored = new BotGroupRuntime(runtime)
    expect(() =>
      restored.assertQueuedMessageAllowed(turn.sessionId, turn.operationId)
    ).not.toThrow()
    expect(() =>
      restored.assertQueuedMessageAllowed(group.members[1].sessionId, turn.operationId)
    ).toThrow(/cannot be verified/)
    await restored.stop(group.id, turn.botId)
    expect(() =>
      new BotGroupRuntime(runtime).assertQueuedMessageAllowed(turn.sessionId, turn.operationId)
    ).toThrow(/no longer active/)
    expect(groups.store.message(message.id)?.turns[0].error).toMatch(/no longer active/)
    expect(() => restored.assertQueuedMessageAllowed('ordinary-home', 'unrelated')).not.toThrow()
  })
  it('retires duplicate quoted context after native admission without redelivering a replay', async () => {
    const { groups } = fixture()
    const group = await groups.create({ name: 'Review', botIds: ['bot-0'] })
    const input = { groupId: group.id, revision: group.revision, messageId: 'human', text: 'hello' }
    const message = await groups.send(input)
    await vi.waitFor(() => expect(groups.store.pending()).toEqual([]))
    expect(() =>
      groups.assertQueuedMessageAllowed(message.turns[0].sessionId, message.turns[0].operationId)
    ).not.toThrow()
    await groups.send(input)
    expect(groupNativeMocks().send).toHaveBeenCalledTimes(1)
  })
  it('cannot admit an old member generation after removal and rejoin', async () => {
    const { groups, runtime } = fixture()
    let group = await groups.create({ name: 'Review', botIds: ['bot-0', 'bot-1'] })
    const message = await groups.send({
      groupId: group.id,
      revision: group.revision,
      messageId: 'human',
      text: 'hello'
    })
    const [turn] = message.turns
    group = await groups.update({ groupId: group.id, revision: group.revision, botIds: ['bot-1'] })
    await groups.update({ groupId: group.id, revision: group.revision, botIds: ['bot-0', 'bot-1'] })
    expect(() =>
      new BotGroupRuntime(runtime).assertQueuedMessageAllowed(turn.sessionId, turn.operationId)
    ).toThrow(/no longer active/)
  })
})
