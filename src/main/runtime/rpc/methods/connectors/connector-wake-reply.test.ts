// A turn that starts on its own posts nothing, so the bot posts itself: a worker start names where
// it came from, and the bot's Chat may answer that DM only while nothing from another conversation
// has reached the Chat since (one person's words never reach another person's DM).
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { origin, reply } = vi.hoisted(() => ({ origin: vi.fn(), reply: vi.fn() }))
vi.mock('../orchestration/messaging/bot-turn-origin', () => ({ readBotTurnOrigin: origin }))
vi.mock('../../../../bots/bot-turn-for', () => ({ botTurnFor: async () => 'owner' }))
vi.mock('../../../../bots/bot-session-tabs', () => ({
  botOfSession: (_bots: unknown, sessionId: string) =>
    sessionId === CHAT ? { id: 'bot-a' } : sessionId === OTHER_CHAT ? { id: 'bot-b' } : null
}))

import { CONNECTOR_METHODS } from './connector'
import { ChatDeliveries } from '../../../../external-conversations/external-conversation-chat-delivery'

const CHAT = '55555555-5555-4555-8555-555555555555'
const OTHER_CHAT = '66666666-6666-4666-8666-666666666666'
const THREAD = 'T1:C1:1712.000100:UBOT'
const DM = 'T1:D0X:D0X:UBOT'
const OTHER_DM = 'T1:D0Y:D0Y:UBOT'
const DM_THREAD = 'T1:D0X:1712.000200:UBOT'
const DM_URL = 'https://app.slack.com/client/T1/D0X'

let target: Record<string, unknown> | null = null
// A connector message opened or joined the running turn, as the host's delivery mark records it.
let delivered = true
let deliveries = new ChatDeliveries(() => {})
const runtime = {
  getOrchestrationDb: () => ({}),
  getConnectorCloud: () => ({ reply }),
  bots: {
    enabled: () => true,
    list: () => [{ id: 'bot-a', folderWorkspaceId: 'w' }]
  },
  getExternalConversationSeam: () => ({
    replyTarget: () => target,
    chatDeliveries: { pending: () => delivered, savedDms: deliveries.savedDms }
  })
}
const context = (sessionId: string) => ({
  runtime,
  orchestrationCaller: {
    address: `orca_session_id:${sessionId}`,
    terminalHandle: null,
    paneKey: null,
    orcaSessionId: sessionId,
    sessionId,
    workspaceId: 'w'
  }
})
const chatOn = (
  externalId: string,
  { answers = 'd1', kind = 'bot' }: { answers?: string | null; kind?: string } = {}
) => ({
  key: { source: 'slack', externalId },
  turnId: 9,
  worktreeId: 'folder:w',
  bot: { kind, botId: 'bot-a' },
  place: `the thread ${externalId}`,
  ...(answers ? { answerDeliveryId: answers } : {})
})

const handler = (name: string) =>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the method's handler, called with the params and context it reads.
  CONNECTOR_METHODS.find((method) => method.name === name)!.handler as (
    params: unknown,
    context: unknown
  ) => Promise<unknown>
const placeFor = (sessionId: string, caller = sessionId) =>
  handler('connector.wakeReplyPlace')({ sessionId }, context(caller))

// The real delivery path: what reaches the Chat is recorded before it is sent, taken or not.
const arrive = (externalId: string, deliveryId: string) =>
  deliveries.deliver(
    undefined,
    { source: 'slack', externalId },
    {
      worktreeId: 'folder:w',
      sessionId: CHAT,
      agent: 'claude',
      bot: { kind: 'bot-chat', botId: 'bot-a' }
    },
    { text: 'hi', deliveryId, signal: new AbortController().signal }
  )
const postTo = (to: string, sessionId = CHAT, caller = sessionId) =>
  handler('connector.replySavedDm')({ sessionId, replyId: 'r1', text: 'done', to }, context(caller))
// A self-started turn: no delivery mark, the Chat still linked to the DM, no opener stamp.
const ownTurn = () => {
  delivered = false
  target = chatOn(DM, { kind: 'bot-chat', answers: null })
}
const startFrom = async (deliveryId: string) => {
  delivered = true
  target = chatOn(DM, { kind: 'bot-chat', answers: deliveryId })
  return placeFor(CHAT)
}

describe('a turn that started on its own can tell the thread its work came from', () => {
  beforeEach(() => {
    delivered = true
    deliveries = new ChatDeliveries(() => {})
    origin.mockResolvedValue({ source: 'slack', placeId: 'C1' })
  })

  it('names the thread only when Orca proves the start came from it', async () => {
    target = chatOn(THREAD)
    expect(await placeFor(CHAT)).toEqual({ place: `the thread ${THREAD}` })
    // A turn that started on its own reads its opener as the last message's: no mark, no place.
    delivered = false
    expect(await placeFor(CHAT)).toEqual({ place: null })
    delivered = true
    // A turn that answers no delivery of this thread, an origin elsewhere, another chat asking, or
    // a thread in the bot's Chat: nothing.
    target = chatOn(THREAD, { answers: null })
    expect(await placeFor(CHAT)).toEqual({ place: null })
    target = chatOn(THREAD)
    origin.mockResolvedValue({ source: 'slack', placeId: 'C2' })
    expect(await placeFor(CHAT)).toEqual({ place: null })
    origin.mockResolvedValue({ source: 'slack', placeId: 'C1' })
    expect(await placeFor(CHAT, OTHER_CHAT)).toEqual({ place: null })
    target = chatOn(THREAD, { kind: 'bot-chat' })
    expect(await placeFor(CHAT)).toEqual({ place: null })
    // A DM in a chat of its own, or a thread inside a DM: neither is a thread chat's thread.
    origin.mockResolvedValue({ source: 'slack', placeId: 'D0X' })
    target = chatOn(DM)
    expect(await placeFor(CHAT)).toEqual({ place: null })
    target = chatOn(DM_THREAD)
    expect(await placeFor(CHAT)).toEqual({ place: null })
  })
})

describe("the bot's Chat answers the DM a start came from, until anyone else writes", () => {
  beforeEach(() => {
    delivered = true
    deliveries = new ChatDeliveries(() => {})
    origin.mockResolvedValue({ source: 'slack', placeId: 'D0X' })
    reply.mockReset()
    reply.mockResolvedValue({ ok: true, value: { status: 'posted' } })
  })

  it('posts in the saved DM from a turn of its own, and again after that DM writes', async () => {
    await arrive(DM, 'd1')
    expect(await startFrom('d1')).toEqual({ place: `the thread ${DM}`, to: DM_URL })
    ownTurn()
    await expect(postTo(DM_URL)).resolves.toMatchObject({ status: 'posted' })
    expect(reply).toHaveBeenLastCalledWith(
      expect.objectContaining({ conversation: expect.objectContaining({ externalId: DM }) })
    )
    // The same DM writing again keeps it: only its own words are in the Chat.
    await arrive(DM, 'd2')
    await expect(postTo(DM_URL)).resolves.toMatchObject({ status: 'posted' })
  })

  it('voids the saved DM once another DM reaches the Chat, whichever turn it lands in', async () => {
    await arrive(DM, 'd1')
    await startFrom('d1')
    // Another DM, queued behind the turn or joining it, then the first DM again so the Chat is
    // linked back to it and the next turn opens on it: still void.
    await arrive(OTHER_DM, 'd2')
    await arrive(DM, 'd3')
    ownTurn()
    await expect(postTo(DM_URL)).rejects.toThrow('not_a_saved_dm')
    expect(reply).not.toHaveBeenCalled()
  })

  it('voids it for an automation run adopted into the Chat, and when the account resets', async () => {
    await arrive(DM, 'd1')
    await startFrom('d1')
    deliveries.adopt(
      { source: 'slack', externalId: OTHER_DM },
      { worktreeId: 'folder:w', sessionId: CHAT, agent: 'claude' },
      'run'
    )
    ownTurn()
    await expect(postTo(DM_URL)).rejects.toThrow('not_a_saved_dm')

    await arrive(DM, 'd4')
    await startFrom('d4')
    deliveries.clear()
    ownTurn()
    await expect(postTo(DM_URL)).rejects.toThrow('not_a_saved_dm')
  })

  it("saves nothing when another DM's words already reached the starting turn", async () => {
    // Another DM joined the turn the DM opened, and the DM wrote again so the link came back.
    await arrive(DM, 'd1')
    await arrive(OTHER_DM, 'd2')
    await arrive(DM, 'd3')
    expect(await startFrom('d1')).toEqual({ place: null })
    // An automation run adopted into the Chat after the opener, then the DM again.
    await arrive(DM, 'd4')
    deliveries.adopt(
      { source: 'slack', externalId: OTHER_DM },
      { worktreeId: 'folder:w', sessionId: CHAT, agent: 'claude' },
      'run'
    )
    await arrive(DM, 'd5')
    expect(await startFrom('d4')).toEqual({ place: null })
    // An opener Orca never saw arrive (a reset since, or an earlier Orca): unknown, nothing.
    expect(await startFrom('d9')).toEqual({ place: null })
    ownTurn()
    await expect(postTo(DM_URL)).rejects.toThrow('not_a_saved_dm')
  })

  it("refuses another bot's chat, another caller, and a Chat no longer linked to that DM", async () => {
    await arrive(DM, 'd1')
    await startFrom('d1')
    ownTurn()
    await expect(postTo(DM_URL, OTHER_CHAT)).rejects.toThrow('not_a_saved_dm')
    await expect(postTo(DM_URL, CHAT, OTHER_CHAT)).rejects.toThrow('not_a_saved_dm')
    target = chatOn(OTHER_DM, { kind: 'bot-chat', answers: null })
    await expect(postTo(DM_URL)).rejects.toThrow('not_a_saved_dm')
    // A deleted bot's saved DMs go with it.
    ownTurn()
    deliveries.savedDms.forgetBot('bot-a')
    await expect(postTo(DM_URL)).rejects.toThrow('not_a_saved_dm')
    expect(reply).not.toHaveBeenCalled()
  })
})
