import '../../../dispatch/testing/unused-default-rpc-methods.test-fixture'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../../../../../shared/bot-types'
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'
import { mapRuntimeError } from '../../../responses/rpc-response'
import { makeTestBot } from '../../../../../bots/bot.test-fixture'
import type * as RecipientRouting from './recipient-routing'
import {
  askedBy,
  caller,
  DOCS_CHAT,
  DOCS_REQUEST,
  journals,
  message,
  noteChats,
  notes,
  RANGER_THREAD,
  sessionsOf,
  setupBotMail,
  startBotSession,
  withChat
} from './bot-recipient.test-fixture'

vi.mock(
  '../../../../../bots/bot-session-tabs',
  async () => (await import('./bot-recipient.test-fixture')).botSessionTabsMock
)
vi.mock(
  '../../../../../bots/bot-chat-session',
  async () => (await import('./bot-recipient.test-fixture')).botChatSessionMock
)
vi.mock(
  '../../../../../bots/bot-chat-mail-hold',
  async () => (await import('./bot-recipient.test-fixture')).botChatMailHoldMock
)
vi.mock(
  '../../../../../bots/bot-chat-status-line',
  async () => (await import('./bot-recipient.test-fixture')).botChatStatusLineMock
)
vi.mock('./recipient-routing', async (importOriginal) =>
  (await import('./bot-recipient.test-fixture')).recipientRoutingMock(
    await importOriginal<typeof RecipientRouting>()
  )
)

const THREE_CHAT = '88888888-8888-4888-8888-888888888881'

/** The bot's turn the requests woke: their mail notice, as the chat's journal shows it. */
let wakes = 0
function wake(sessionId: string, ...messageIds: string[]): void {
  wakes += 1
  journals[sessionId] = [
    message(`woken-${wakes}`, {
      from: {
        kind: 'agent',
        senders: [],
        orchestration: {
          message: 'mail-notice',
          mailbox: `orca_session_id:${sessionId}`,
          dispatchId: null,
          messages: messageIds.map((messageId) => ({ messageId, runId: 'run', from: 'x' }))
        }
      }
    })
  ]
}

describe("a bot request chain's limits", () => {
  const h = createOrchestrationRpcHarness()
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let bots: Bot[]
  let send: ReturnType<typeof setupBotMail>['send']
  let sent: ReturnType<typeof setupBotMail>['sent']

  const record = (receipt: { message: { id: string } }) => {
    const row = db.getBotRequest(receipt.message.id)!
    return { depth: row.depth, rootKey: row.root_key, ...JSON.parse(row.record) }
  }

  beforeEach(() => {
    ;({ db, runtime, bots, send, sent } = setupBotMail(h))
    bots.push(makeTestBot({ id: 'three', name: 'Three' }))
    sessionsOf.three = [THREE_CHAT]
    withChat.mockImplementation((botId: string, work: (sessionId: string) => unknown) =>
      work(sessionsOf[botId]![0]!)
    )
  })
  afterEach(() => h.cleanup())

  it('stops a chain at its 13th hand-off, tells the sender and the owner why, and a reply starts it fresh', async () => {
    journals[RANGER_THREAD] = [message('ask')]
    let receipt = await sent(RANGER_THREAD, { to: 'bot:Docs', type: 'question', subject: 'hop 1' })
    for (let hop = 2; hop <= 12; hop += 1) {
      const from = hop % 2 === 0 ? DOCS_CHAT : RANGER_THREAD
      wake(from, receipt.message.id)
      const to = from === DOCS_CHAT ? 'bot:Ranger' : 'bot:Docs'
      receipt = await sent(from, { to, type: 'question', subject: `hop ${hop}` })
    }
    expect(record(receipt).depth).toBe(12)
    wake(RANGER_THREAD, receipt.message.id)
    const thirteenth = { to: 'bot:Docs', type: 'question', subject: 'hop 13' }
    const refused = await send(RANGER_THREAD, thirteenth).catch((error: unknown) => error)
    // Callers read the code, not just the words.
    expect(mapRuntimeError('r1', { runtimeId: 'rt' }, refused).error).toMatchObject({
      code: 'bot_request_chain_limit'
    })
    expect(noteChats.at(-1)).toBe(RANGER_THREAD)
    // The owner's reply is a new turn: one send goes on, as a fresh chain.
    journals[RANGER_THREAD]!.push(message('go on'))
    const resumed = await sent(RANGER_THREAD, thirteenth)
    expect(record(resumed).depth).toBe(1)
  })

  it('holds one bot to 30 requests to another in 10 minutes, whatever the chain', async () => {
    journals[RANGER_THREAD] = [message('ask')]
    for (let request = 1; request <= 30; request += 1) {
      await sent(RANGER_THREAD, { to: 'bot:Docs', type: 'status', subject: `note ${request}` })
    }
    const next = { to: 'bot:Docs', type: 'question', subject: 'one more' }
    await expect(send(RANGER_THREAD, next)).rejects.toMatchObject({
      code: 'bot_request_rate_limit'
    })
    expect(noteChats.at(-1)).toBe(RANGER_THREAD)
    // Another pair is its own.
    expect((await sent(RANGER_THREAD, { to: 'bot:Three', type: 'question' })).message).toBeDefined()
  })

  /** Ranger's requests to Docs already in this window. */
  const alreadySent = (count: number) => {
    for (let request = 0; request < count; request += 1) {
      db.reserveBotRequest({
        messageId: `msg_earlier_${request}`,
        rootKey: 'earlier',
        fromBotId: 'ranger',
        toBotId: 'docs',
        purpose: 'status',
        depth: 1,
        record: '{}'
      })
    }
  }
  const toDocs = () => db.botRequestsSentWithin({ fromBotId: 'ranger', toBotId: 'docs' }, 10).count

  it('lets only one of two racing sends take the last place in the quota', async () => {
    journals[RANGER_THREAD] = [message('ask')]
    alreadySent(29)
    withChat.mockClear()
    const racing = await Promise.allSettled([
      send(RANGER_THREAD, { to: 'bot:Docs', type: 'question', subject: 'first' }),
      send(RANGER_THREAD, { to: 'bot:Docs', type: 'question', subject: 'second' })
    ])
    expect(racing.map((result) => result.status).toSorted()).toEqual(['fulfilled', 'rejected'])
    expect(racing.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'bot_request_rate_limit' }
    })
    expect(toDocs()).toBe(30)
    // The refused one never reached Docs' Home Chat.
    expect(withChat).toHaveBeenCalledTimes(1)
  })

  it('answers the same send again while the first still holds the last place with its receipt', async () => {
    journals[RANGER_THREAD] = [message('ask')]
    alreadySent(29)
    // The first send holds the last place while Docs' Home Chat is found for it.
    let found: () => void = () => {}
    withChat.mockImplementationOnce(
      (_botId: string, work: (sessionId: string) => unknown) =>
        new Promise((resolve) => (found = () => resolve(work(DOCS_CHAT))))
    )
    const last = { to: 'bot:Docs', type: 'question', subject: 'the 30th' }
    const first = sent(RANGER_THREAD, last)
    await vi.waitFor(() => expect(withChat).toHaveBeenCalled())
    const again = await sent(RANGER_THREAD, last)
    expect(again.message).toBeDefined()
    found()
    expect(await first).toMatchObject({ duplicate: true, message: { id: again.message.id } })
    expect(toDocs()).toBe(30)
  })

  it('counts a send its quota place once while it is both held and reserved', async () => {
    journals[RANGER_THREAD] = [message('ask')]
    alreadySent(28)
    // The new chat for the first send is still being made: it is reserved and still held.
    let chatMade: (sessionId: string) => void = () => {}
    startBotSession.mockImplementationOnce(() => new Promise((made) => (chatMade = made)))
    const first = send(RANGER_THREAD, { to: 'bot:Docs', type: 'question', chat: 'new' })
    await vi.waitFor(() => expect(toDocs()).toBe(29))
    const second = await sent(RANGER_THREAD, { to: 'bot:Docs', type: 'question', subject: 'next' })
    expect(second.message).toBeDefined()
    chatMade(DOCS_REQUEST)
    await first
    expect(toDocs()).toBe(30)
  })

  it("never makes or shows the target's Home Chat for a send past the quota", async () => {
    journals[RANGER_THREAD] = [message('ask')]
    alreadySent(30)
    withChat.mockClear()
    await expect(
      send(RANGER_THREAD, { to: 'bot:Docs', type: 'question', subject: 'over' })
    ).rejects.toMatchObject({ code: 'bot_request_rate_limit' })
    expect(withChat).not.toHaveBeenCalled()
  })

  it('answers a retry at the quota as the same send, and tells the owner of one refusal once', async () => {
    journals[RANGER_THREAD] = [message('ask')]
    alreadySent(29)
    const last = { to: 'bot:Docs', type: 'question', subject: 'the 30th' }
    const first = await sent(RANGER_THREAD, last)
    expect(await sent(RANGER_THREAD, last)).toMatchObject({
      duplicate: true,
      message: { id: first.message.id }
    })
    const over = { to: 'bot:Docs', type: 'question', subject: 'the 31st' }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(send(RANGER_THREAD, over)).rejects.toMatchObject({
        code: 'bot_request_rate_limit'
      })
    }
    expect(notes).toHaveLength(1)
  })

  /** Ranger's turn woken by the chain's 12th hand-off, with `joined` steered into it. */
  const twelfthWithJoined = (joined: Record<string, unknown>) => {
    db.reserveBotRequest({
      messageId: 'msg_twelfth',
      rootKey: 'root',
      fromBotId: 'docs',
      toBotId: 'ranger',
      purpose: 'question',
      depth: 12,
      record: JSON.stringify({ askers: [{ kind: 'owner' }] })
    })
    wake(RANGER_THREAD, 'msg_twelfth')
    const woken = journals[RANGER_THREAD]![0]!
    journals[RANGER_THREAD]!.push(
      {
        ...message('turn'),
        body: { kind: 'turn', turnId: 'turn_1', state: 'running', userItemId: woken.itemId }
      },
      { ...message('joined', joined), turnScope: { kind: 'turn', turnItemId: 'turn' } }
    )
  }
  const slackAsker = (extra: Record<string, unknown>) => ({
    origin: 'connector',
    asker: {
      source: 'slack',
      userId: 'U_LINT',
      name: 'Lint',
      role: 'member',
      place: { kind: 'public_channel', id: 'C1' },
      ...extra
    }
  })

  it("never starts a chain over for another Slack app's post that joins its 12th hand-off", async () => {
    twelfthWithJoined(slackAsker({ app: true }))
    withChat.mockClear()
    await expect(send(RANGER_THREAD, { to: 'bot:Docs', type: 'question' })).rejects.toMatchObject({
      code: 'bot_request_chain_limit'
    })
    expect(withChat).not.toHaveBeenCalled()
  })

  it("starts a chain over for a person's own words joined to it, never another Orca bot's", async () => {
    twelfthWithJoined(slackAsker({ via: { userId: 'U_DOCS', name: 'Docs' } }))
    await expect(send(RANGER_THREAD, { to: 'bot:Docs', type: 'question' })).rejects.toMatchObject({
      code: 'bot_request_chain_limit'
    })
    journals[RANGER_THREAD]![2] = {
      ...message('person', slackAsker({})),
      turnScope: { kind: 'turn', turnItemId: 'turn' }
    }
    const fresh = await sent(RANGER_THREAD, { to: 'bot:Docs', type: 'question' })
    expect(record(fresh).depth).toBe(1)
  })

  /** term_worker, started by Ranger's Slack thread, where Dana asked. */
  function rangerWorker(): string {
    journals[RANGER_THREAD] = [message('ask', askedBy('U_DANA', 'Dana'))]
    const run = db.createRun({
      objective: 'worker scope',
      coordinatorHandle: null,
      coordinatorPaneKey: null,
      coordinatorOrcaSessionId: caller(RANGER_THREAD).orcaSessionId
    })
    const task = db.createTask({ runId: run.id, spec: 'worker' })
    return db.createDispatchContext({
      taskId: task.id,
      assigneeHandle: 'term_worker',
      creator: { kind: 'session', orcaSessionId: caller(RANGER_THREAD).orcaSessionId },
      maxDepth: 2
    }).id
  }

  it("holds a bot's worker to its chat's chain, so a stopped chain doesn't start over", async () => {
    rangerWorker()
    // Ranger's turn was woken by the chain's 12th hand-off.
    db.reserveBotRequest({
      messageId: 'msg_twelfth',
      rootKey: 'root',
      fromBotId: 'docs',
      toBotId: 'ranger',
      purpose: 'question',
      depth: 12,
      record: JSON.stringify({ askers: [{ kind: 'owner' }] })
    })
    const notice = {
      message: 'mail-notice',
      mailbox: `orca_session_id:${RANGER_THREAD}`,
      dispatchId: null,
      messages: [{ messageId: 'msg_twelfth', runId: 'run', from: 'x' }]
    }
    journals[RANGER_THREAD]!.push(
      message('woken', { from: { kind: 'agent', senders: [], orchestration: notice } })
    )
    await expect(
      h.call(
        'orchestration.send',
        { from: 'term_worker', subject: 'which install path?', to: 'bot:Docs', type: 'question' },
        { runtime }
      )
    ).rejects.toMatchObject({ code: 'bot_request_chain_limit' })
  })
})
