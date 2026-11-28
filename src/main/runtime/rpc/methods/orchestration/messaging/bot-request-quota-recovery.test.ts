// The pair quota's last place, given back by a send that failed after taking it: in its own file, so
// no other send's place in this process (held or stored) is counted with it.
import '../../../dispatch/testing/unused-default-rpc-methods.test-fixture'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'
import type * as RecipientRouting from './recipient-routing'
import {
  DOCS_REQUEST,
  journals,
  message,
  RANGER_THREAD,
  setupBotMail,
  startBotSession
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

describe("a pair quota's last place", () => {
  const h = createOrchestrationRpcHarness()
  let db: OrchestrationDb
  let send: ReturnType<typeof setupBotMail>['send']
  let sent: ReturnType<typeof setupBotMail>['sent']

  beforeEach(() => {
    ;({ db, send, sent } = setupBotMail(h))
    journals[RANGER_THREAD] = [message('ask')]
    // Ranger's 29 requests to Docs already in this window.
    for (let request = 0; request < 29; request += 1) {
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
  })
  afterEach(() => h.cleanup())

  const toDocs = () => db.botRequestsSentWithin({ fromBotId: 'ranger', toBotId: 'docs' }, 10).count
  /** The requests stored for Ranger to Docs beyond the 29 seeded. */
  const ownRequests = () =>
    db.db
      .prepare(
        "SELECT message_id FROM bot_requests WHERE from_bot_id = 'ranger' AND to_bot_id = 'docs' AND message_id NOT LIKE 'msg_earlier_%'"
      )
      .all()
      .flatMap((row) =>
        typeof row === 'object' && row !== null && 'message_id' in row
          ? [String(row.message_id)]
          : []
      )
  const mailWithId = (id: string) => db.getMessageById(id) !== undefined

  it('gives it back when its new chat fails to start, and the same send then takes it', async () => {
    let failStart: (error: Error) => void = () => {}
    startBotSession.mockImplementationOnce(
      () => new Promise<string>((_made, fail) => (failStart = fail))
    )
    const last = { to: 'bot:Docs', type: 'question', subject: 'the 30th', chat: 'new' }
    const failing = send(RANGER_THREAD, last)
    // The 30th: reserved, its chat still being made.
    await vi.waitFor(() => expect(ownRequests()).toHaveLength(1))
    const [thirtieth] = ownRequests()
    expect(toDocs()).toBe(30)
    failStart(new Error('could not start'))
    await expect(failing).rejects.toThrow('could not start')
    expect(toDocs()).toBe(29)
    expect(db.getBotRequest(thirtieth!)).toBeUndefined()
    expect(mailWithId(thirtieth!)).toBe(false)
    // The same send, as a new operation, takes the place it gave back.
    startBotSession.mockResolvedValueOnce(DOCS_REQUEST)
    const again = await sent(RANGER_THREAD, last)
    expect(again.message).toBeDefined()
    expect(toDocs()).toBe(30)
  })
})
