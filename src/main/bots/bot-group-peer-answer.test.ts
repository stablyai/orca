import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { fixture, groupNativeMocks, journal } from './bot-group-native-runtime.test-fixture'

const live = vi.hoisted((): { turnItemId: string | null } => ({ turnItemId: null }))
vi.mock('../native-chat/agent-session-wire/host/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => ({
    currentWork: async () => ({
      activeTurn: () => (live.turnItemId ? { item: { itemId: live.turnItemId } } : null)
    }),
    journalReads: async (sessionId: string) => ({
      operationWindow: async () => ({ snapshot: await groupNativeMocks().snapshot(sessionId) })
    })
  })
}))

const mocks = groupNativeMocks()

/** Scout asked in the room; its turn answered a member's request by mail, then ended with `reply`. */
async function answered(reply: string, answer: string, running = true) {
  const { groups } = fixture()
  const group = await groups.create({ name: 'Review', botIds: ['bot-0', 'bot-1'] })
  const send = (text: string) =>
    groups.send({ groupId: group.id, revision: group.revision, messageId: randomUUID(), text })
  const asked = await send('@Scout work out 20160088 - 34/3')
  const operationId = asked.turns[0]!.operationId
  mocks.snapshot.mockImplementation(async (sessionId) =>
    journal(sessionId, [{ operationId, text: reply, at: asked.createdAt }])
  )
  live.turnItemId = running ? `turn-${operationId}` : null
  const turn = await groups.answerTurn(group.members[0]!.sessionId, answer)
  if (turn) {
    groups.saveAnswer(turn, answer)
  }
  live.turnItemId = null
  const next = await send('@Forge where is the result?')
  return { saved: groups.store.message(asked.id)?.turns[0]?.answer, turn, groups, next }
}

it("saves a member's mailed answer on its live room turn and gives it to the next member", async () => {
  const { saved, groups, next } = await answered('NO_REPLY', 'Result: 20160076.666666668')
  expect(saved).toBe('Result: 20160076.666666668')
  const context = groups.store.pendingContext(next.turns[0]!.operationId)
  expect(context).toContain('Result: 20160076.666666668')
  expect(context).not.toContain('NO_REPLY')
})

it('gives the next member an answer its reply already says only once', async () => {
  const { groups, next } = await answered(
    'Done. Result: 20160076.666666668',
    'Result: 20160076.666666668'
  )
  const context = groups.store.pendingContext(next.turns[0]!.operationId) ?? ''
  expect(context.split('Result: 20160076.666666668')).toHaveLength(2)
})

it('finds no room turn for an answer once the turn that sent it is not running', async () => {
  const { saved, turn } = await answered('NO_REPLY', 'Result: 42', false)
  expect(turn).toBeNull()
  expect(saved).toBeUndefined()
})

it("shortens members' long answers on a room page so the page stays under the reply limit", async () => {
  const { groups } = fixture()
  const group = await groups.create({ name: 'Review', botIds: ['bot-0', 'bot-1'] })
  for (let i = 0; i < 5; i++) {
    const post = await groups.send({
      groupId: group.id,
      revision: group.revision,
      messageId: randomUUID(),
      text: `@Scout dump log ${i}`
    })
    const answer = i === 0 ? 'Result: 42' : 'x'.repeat(2_000_000)
    groups.store.update({ ...post, turns: post.turns.map((turn) => ({ ...turn, answer })) })
  }
  const page = groups.read(group.id)
  expect(page.messages.map((message) => message.turns[0]?.answer?.length)).toEqual([
    10, 16_000, 16_000, 16_000, 16_000
  ])
  expect(JSON.stringify(page).length).toBeLessThan(200_000)
})
