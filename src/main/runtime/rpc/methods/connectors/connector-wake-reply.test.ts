// A turn that starts on its own posts nothing, so the bot posts itself: a worker start names where
// it came from, and the bot's Chat may answer that DM only while nothing from another conversation
// has reached the Chat since (one person's words never reach another person's DM).
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { origin, reply, turnFor } = vi.hoisted(() => ({
  origin: vi.fn(),
  reply: vi.fn(),
  turnFor: vi.fn()
}))
vi.mock('../orchestration/messaging/bot-turn-origin', () => ({ readBotTurnOrigin: origin }))
vi.mock('../../../../bots/bot-turn-for', () => ({ botTurnFor: turnFor }))
vi.mock('../../../../bots/bot-session-tabs', () => ({
  botOfSession: (_bots: unknown, sessionId: string) =>
    sessionId === CHAT ? { id: 'bot-a' } : sessionId === OTHER_CHAT ? { id: 'bot-b' } : null
}))

import { CONNECTOR_METHODS } from './connector'
import { ChatDeliveries } from '../../../../external-conversations/external-conversation-chat-delivery'
import type { AgentJournalMessageItem } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import { ExternalConversationSeam } from '../../../../external-conversations/external-conversation-seam'
import type { DeliveryReceipts } from '../../../../external-conversations/external-conversation-delivery-receipts'
import {
  closeTestStores,
  createStore,
  testState
} from '../../../../persistence/persistence-test-harness'

const CHAT = '55555555-5555-4555-8555-555555555555'
const OTHER_CHAT = '66666666-6666-4666-8666-666666666666'
const THREAD = 'T1:C1:1712.000100:UBOT'
const DM = 'T1:D0X:D0X:UBOT'
const OTHER_DM = 'T1:D0Y:D0Y:UBOT'
const DM_THREAD = 'T1:D0X:1712.000200:UBOT'
const DM_URL = 'https://app.slack.com/client/T1/D0X'
const owner = (text: string): AgentJournalMessageItem => ({
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text }]
})

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
const arrive = (externalId: string, deliveryId: string, sessionId = CHAT) =>
  deliveries.deliver(
    undefined,
    { source: 'slack', externalId },
    {
      worktreeId: 'folder:w',
      sessionId,
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
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: connector.wakeReplyPlace's result shape.
  return (await placeFor(CHAT)) as { place: string | null; to?: string }
}
/** A start that saved the DM: its own `--to`. */
const savedFrom = async (deliveryId: string) => {
  const { to } = await startFrom(deliveryId)
  expect(to?.startsWith(`${DM_URL}#`)).toBe(true)
  return to!
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
    turnFor.mockReset()
    turnFor.mockResolvedValue('owner')
  })

  it('posts in the saved DM from a turn of its own, and again after that DM writes', async () => {
    await arrive(DM, 'd1')
    const to = await savedFrom('d1')
    ownTurn()
    await expect(postTo(to)).resolves.toMatchObject({ status: 'posted' })
    expect(reply).toHaveBeenLastCalledWith(
      expect.objectContaining({ conversation: expect.objectContaining({ externalId: DM }) }),
      expect.any(Function)
    )
    // The same DM writing again, or the owner typing, keeps it.
    await arrive(DM, 'd2')
    deliveries.savedDms.admitted(CHAT, owner('ship it'))
    await expect(postTo(to)).resolves.toMatchObject({ status: 'posted' })
    // The bare DM link was never saved: only the start's own --to works.
    await expect(postTo(DM_URL)).rejects.toThrow('not_a_saved_dm')
  })

  it('voids the saved DM once another DM reaches the Chat, whichever turn it lands in', async () => {
    await arrive(DM, 'd1')
    const to = await savedFrom('d1')
    // Another DM, queued behind the turn or joining it, then the first DM again so the Chat is
    // linked back to it and the next turn opens on it: still void.
    await arrive(OTHER_DM, 'd2')
    await arrive(DM, 'd3')
    ownTurn()
    await expect(postTo(to)).rejects.toThrow('not_a_saved_dm')
    // A later start from the same DM saves anew; the voided note stays void.
    const again = await savedFrom('d3')
    ownTurn()
    await expect(postTo(to)).rejects.toThrow('not_a_saved_dm')
    await expect(postTo(again)).resolves.toMatchObject({ status: 'posted' })
    expect(reply).toHaveBeenCalledTimes(1)
  })

  it('voids it for words the Chat took any other way: an adopted run, an event, a resent card', async () => {
    const others = [
      () =>
        deliveries.adopt(
          { source: 'slack', externalId: OTHER_DM },
          { worktreeId: 'folder:w', sessionId: CHAT, agent: 'claude' },
          'run'
        ),
      () =>
        deliveries.savedDms.admitted(CHAT, {
          ...owner('deploy failed'),
          origin: 'automation-run',
          memorySource: 'Webhook deploys'
        }),
      () =>
        deliveries.savedDms.admitted(CHAT, {
          ...owner('from the other DM'),
          origin: 'connector',
          connectorConversation: { source: 'slack', externalId: OTHER_DM }
        })
    ]
    let id = 0
    for (const other of others) {
      await arrive(DM, `d${++id}`)
      const to = await savedFrom(`d${id}`)
      other()
      ownTurn()
      await expect(postTo(to)).rejects.toThrow('not_a_saved_dm')
    }
  })

  it("voids it on a reset, and drops what a bot's retired Chat kept", async () => {
    await arrive(DM, 'd1')
    const to = await savedFrom('d1')
    deliveries.clear()
    ownTurn()
    await expect(postTo(to)).rejects.toThrow('not_a_saved_dm')

    await arrive(DM, 'd2')
    const kept = await savedFrom('d2')
    // The bot's new Chat takes its first message: the old Chat's saved DMs go.
    await arrive(DM, 'd3', OTHER_CHAT)
    ownTurn()
    await expect(postTo(kept)).rejects.toThrow('not_a_saved_dm')
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
    // An event's run the Chat took after the opener.
    await arrive(DM, 'd6')
    deliveries.savedDms.admitted(CHAT, { ...owner('event'), origin: 'automation-run' })
    expect(await startFrom('d6')).toEqual({ place: null })
    // An opener Orca never saw arrive (a reset since, or an earlier Orca): unknown, nothing.
    expect(await startFrom('d9')).toEqual({ place: null })
  })

  it('stops a post another DM overtakes while it is on its way', async () => {
    await arrive(DM, 'd1')
    const to = await savedFrom('d1')
    ownTurn()
    // Another DM arrives while the post reads whom its turn acts for.
    turnFor.mockImplementationOnce(async () => {
      await arrive(OTHER_DM, 'd2')
      return 'owner'
    })
    await expect(postTo(to)).rejects.toThrow('not_a_saved_dm')
    expect(reply).not.toHaveBeenCalled()
    // Or between the cloud's retries: the next retry is told not to go.
    await arrive(DM, 'd3')
    const again = await savedFrom('d3')
    ownTurn()
    await postTo(again)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the reply's proceed check, as sendReply passes it.
    const proceed = reply.mock.lastCall?.[1] as () => boolean
    expect(proceed()).toBe(true)
    await arrive(OTHER_DM, 'd4')
    expect(proceed()).toBe(false)
  })

  it("refuses another bot's chat, another caller, and a Chat no longer linked to that DM", async () => {
    await arrive(DM, 'd1')
    const to = await savedFrom('d1')
    ownTurn()
    await expect(postTo(to, OTHER_CHAT)).rejects.toThrow('not_a_saved_dm')
    await expect(postTo(to, CHAT, OTHER_CHAT)).rejects.toThrow('not_a_saved_dm')
    target = chatOn(OTHER_DM, { kind: 'bot-chat', answers: null })
    await expect(postTo(to)).rejects.toThrow('not_a_saved_dm')
    // A deleted bot's saved DMs go with it.
    ownTurn()
    deliveries.savedDms.forgetBot('bot-a')
    await expect(postTo(to)).rejects.toThrow('not_a_saved_dm')
    expect(reply).not.toHaveBeenCalled()
  })
})

describe("the seam voids a saved DM for any message its Chat admits with someone else's words", () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-saved-dm-'))
    delivered = true
    origin.mockResolvedValue({ source: 'slack', placeId: 'D0X' })
  })
  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('such as an event run sent straight to the Chat, which no delivery or adoption names', async () => {
    const seam = new ExternalConversationSeam({
      store: createStore(),
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: admission never reads receipts.
      receipts: {} as DeliveryReceipts,
      onWorkspaceRemoved: () => () => {},
      readHookRow: () => null,
      onAgentPaneChange: () => () => {}
    })
    deliveries = seam.chatDeliveries
    await arrive(DM, 'd1')
    const to = await savedFrom('d1')
    const admit = (body: AgentJournalMessageItem) =>
      seam.messageAdmitted({
        sessionId: CHAT,
        workspaceId: 'folder:w',
        clientMessageId: 'm1',
        body,
        joinsRunningTurn: false
      })
    admit(owner('ship it'))
    expect(deliveries.savedDms.savedDm(CHAT, 'bot-a', to)).not.toBeNull()
    admit({ ...owner('deploy failed'), origin: 'automation-run' })
    expect(deliveries.savedDms.savedDm(CHAT, 'bot-a', to)).toBeNull()
  })
})
