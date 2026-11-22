// A group post's history reads each page message once after the member chat reads, not once per
// turn: re-reading per turn decoded a three-member post three extra times (PR #46117 added it).
import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { completedGroupReplies } from './bot-group-completed-replies'
import { fixture, groupNativeMocks, journal } from './bot-group-native-runtime.test-fixture'

vi.mock('../native-chat/agent-session-wire/host/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => ({
    currentWork: async () => ({ activeTurn: () => null }),
    journalReads: async (sessionId: string) => ({
      operationWindow: async () => ({ snapshot: await groupNativeMocks().snapshot(sessionId) })
    })
  })
}))

it('re-reads each page message once, however many members each post woke', async () => {
  const { groups } = fixture()
  groupNativeMocks().snapshot.mockImplementation(async (sessionId) => journal(sessionId, []))
  const group = await groups.create({ name: 'Review', botIds: ['bot-0', 'bot-1', 'bot-2'] })
  for (let i = 0; i < 5; i++) {
    await groups.send({
      groupId: group.id,
      revision: group.revision,
      messageId: randomUUID(),
      text: `@Scout @Forge @Sage step ${i}`
    })
  }
  const page = groups.store.roomMessages(group.id, undefined, 40)
  expect(page.flatMap((message) => message.turns)).toHaveLength(15)

  const message = vi.spyOn(groups.store, 'message')
  await completedGroupReplies(groups, page)
  expect(message).toHaveBeenCalledTimes(5)
})
