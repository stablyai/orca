// A turn that starts on its own posts nothing to its thread or DM, so the bot posts itself: a worker
// start names the place only when Orca proves the start came from it, in a chat of that place's own.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { origin } = vi.hoisted(() => ({ origin: vi.fn() }))
vi.mock('../orchestration/messaging/bot-turn-origin', () => ({ readBotTurnOrigin: origin }))
vi.mock('../../../../bots/bot-session-tabs', () => ({
  botOfSession: (_bots: unknown, sessionId: string) =>
    sessionId === CHAT ? { id: 'bot-a' } : sessionId === OTHER_CHAT ? { id: 'bot-b' } : null
}))

import { CONNECTOR_METHODS } from './connector'

const CHAT = '55555555-5555-4555-8555-555555555555'
const OTHER_CHAT = '66666666-6666-4666-8666-666666666666'
const THREAD = 'T1:C1:1712.000100:UBOT'
const DM = 'T1:D0X:D0X:UBOT'
const DM_THREAD = 'T1:D0X:1712.000200:UBOT'
const CHANNEL = 'T1:C1:C1:UBOT'

let target: Record<string, unknown> | null = null
// A connector message opened or joined the running turn, as the host's delivery mark records it.
let delivered = true
const runtime = {
  getOrchestrationDb: () => ({}),
  bots: {
    enabled: () => true,
    list: () => [{ id: 'bot-a', folderWorkspaceId: 'w' }]
  },
  getExternalConversationSeam: () => ({
    replyTarget: () => target,
    deliveredTurn: () => delivered
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
  { answers = true, kind = 'bot' }: { answers?: boolean; kind?: string } = {}
) => ({
  key: { source: 'slack', externalId },
  turnId: 9,
  worktreeId: 'folder:w',
  bot: { kind, botId: 'bot-a' },
  place: `the thread ${externalId}`,
  ...(answers ? { answerDeliveryId: 'd1' } : {})
})

const handler = (name: string) =>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the method's handler, called with the params and context it reads.
  CONNECTOR_METHODS.find((method) => method.name === name)!.handler as (
    params: unknown,
    context: unknown
  ) => Promise<unknown>
const placeFor = (sessionId: string, caller = sessionId) =>
  handler('connector.wakeReplyPlace')({ sessionId }, context(caller))

describe('a turn that started on its own can tell the thread its work came from', () => {
  beforeEach(() => {
    delivered = true
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
    // the bot's Chat (many conversations): nothing.
    target = chatOn(THREAD, { answers: false })
    expect(await placeFor(CHAT)).toEqual({ place: null })
    target = chatOn(THREAD)
    origin.mockResolvedValue({ source: 'slack', placeId: 'C2' })
    expect(await placeFor(CHAT)).toEqual({ place: null })
    origin.mockResolvedValue({ source: 'slack', placeId: 'C1' })
    expect(await placeFor(CHAT, OTHER_CHAT)).toEqual({ place: null })
    target = chatOn(THREAD, { kind: 'bot-chat' })
    expect(await placeFor(CHAT)).toEqual({ place: null })
    // A channel with no thread is no place a reply could answer.
    target = chatOn(CHANNEL)
    expect(await placeFor(CHAT)).toEqual({ place: null })
  })

  it("names a DM's own chat, and a thread's inside a DM, on the same proofs; never the bot's Chat", async () => {
    origin.mockResolvedValue({ source: 'slack', placeId: 'D0X' })
    for (const dm of [DM, DM_THREAD]) {
      target = chatOn(dm)
      expect(await placeFor(CHAT)).toEqual({ place: `the thread ${dm}` })
      target = chatOn(dm, { kind: 'bot-chat' })
      expect(await placeFor(CHAT)).toEqual({ place: null })
      target = chatOn(dm, { answers: false })
      expect(await placeFor(CHAT)).toEqual({ place: null })
      target = chatOn(dm)
      delivered = false
      expect(await placeFor(CHAT)).toEqual({ place: null })
      delivered = true
    }
    // Its work started in another DM: nothing.
    origin.mockResolvedValue({ source: 'slack', placeId: 'D0Y' })
    target = chatOn(DM)
    expect(await placeFor(CHAT)).toEqual({ place: null })
  })
})
