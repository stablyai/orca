import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { BotRequestRecord } from '../../../../../bots/bot-request-view'
import {
  botAnswerPayload,
  dropUnreadBotRequests,
  noteBotRequestPost,
  settleBotRequestTurn
} from './bot-request-outcome'
import { installSenderHost, removeSenderHost } from './bot-request-sender-host.test-fixture'

const acting = vi.hoisted((): { requestIds: string[] } => ({ requestIds: [] }))
vi.mock('./bot-recipient', () => ({
  readBotTurn: async () => ({
    turn: {
      rootItemId: 'i',
      askers: [],
      request: null,
      actingOnRequestId: acting.requestIds[0] ?? null,
      requestIds: acting.requestIds
    },
    conversation: null
  })
}))
vi.mock('../../../../../bots/bot-session-tabs', () => ({
  botOfSession: (_bots: unknown, sessionId: string) =>
    sessionId === 'docs-session' ? { id: 'docs' } : null
}))

const record: BotRequestRecord = {
  fromBotId: 'ranger',
  fromBotName: 'Ranger',
  toBotId: 'docs',
  toBotName: 'Docs',
  purpose: 'handoff',
  depth: 1,
  askers: [
    {
      kind: 'person',
      source: 'slack',
      userId: 'U_NORA',
      name: 'Nora',
      workspaceId: 'T1',
      role: 'member',
      placeKind: 'public_channel'
    }
  ],
  request: 'update the docs',
  conversation: { source: 'slack', externalId: 'T1:C1:1712.1:UBOT' }
}

describe('how a bot request ends', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  const notified: string[] = []

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    notified.length = 0
    acting.requestIds = []
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these functions read only the db, the bot list and the mail nudge.
    runtime = {
      getOrchestrationDb: () => db,
      bots: { list: () => [{ id: 'docs' }] },
      notifyMessageArrived: (to: string) => notified.push(to),
      getLiveTerminalPaneKey: () => null,
      ensureStructuredAgentSessionHost: async () =>
        installSenderHost(['11111111-1111-4111-8111-111111111111'])
    } as unknown as OrcaRuntimeService
  })
  afterEach(() => {
    removeSenderHost()
    db.close()
  })

  function request(purpose: 'status' | 'handoff' | 'question' = 'handoff', root = 'root'): string {
    const admitted = db.admitBotRequest({
      rootKey: `${root}-${purpose}`,
      fromBotId: 'ranger',
      toBotId: 'docs',
      purpose,
      depth: 1,
      record: JSON.stringify({ ...record, purpose }),
      message: {
        from: 'orca_session_id:11111111-1111-4111-8111-111111111111',
        to: 'orca_session_id:22222222-2222-4222-8222-222222222222',
        subject: 'update the docs',
        type: purpose
      }
    })
    return admitted.kind === 'sent' ? admitted.message.id : ''
  }

  const mailToRanger = () =>
    db.getAllMessagesForHandle('orca_session_id:11111111-1111-4111-8111-111111111111')

  it("tells the sender to pass an answer on, or that it's already posted", async () => {
    const id = request()
    const original = db.getMessageById(id)!
    expect(JSON.parse(botAnswerPayload(db, original)!).botAnswer.next).toBe(
      'Pass this answer on to Nora on Slack as your final message.'
    )
    expect(db.getBotRequestOutcome(id)).toBe('answered')
    expect(botAnswerPayload(db, { ...original, id: 'msg_not_a_request' })).toBeUndefined()
  })

  it('notes a post in the thread the request was asked in, and only there', async () => {
    const id = request()
    acting.requestIds = [id]
    await noteBotRequestPost(runtime, 'docs-session', 'slack:T1:C2:1712.1')
    expect(db.getBotRequestOutcome(id)).toBeNull()
    await noteBotRequestPost(runtime, 'docs-session', 'slack:T1:C1:1712.1:1712.9')
    expect(db.getBotRequestOutcome(id)).toBe('posted')
    const payload = botAnswerPayload(db, db.getMessageById(id)!)!
    expect(JSON.parse(payload).botAnswer.next).toMatch(/don't post it again/)
  })

  it('wakes the sender once when a turn on the request ends with no answer', async () => {
    const id = request()
    acting.requestIds = [id]
    await settleBotRequestTurn(runtime, 'docs-session')
    await settleBotRequestTurn(runtime, 'docs-session')
    expect(mailToRanger().map((mail) => mail.body)).toEqual([
      "Docs ended its turn without answering your handoff, so do it yourself or tell Nora on Slack that Docs couldn't take it."
    ])
    expect(notified).toEqual(['orca_session_id:11111111-1111-4111-8111-111111111111'])
  })

  it('passes on one answer to a request, and a late one after Orca said it went unanswered', async () => {
    const id = request()
    acting.requestIds = [id]
    await settleBotRequestTurn(runtime, 'docs-session')
    const original = db.getMessageById(id)!
    expect(botAnswerPayload(db, original)).toBeDefined()
    expect(() => botAnswerPayload(db, original)).toThrow('You already answered that request')
  })

  it('tells the sender of every request a turn took and left unanswered', async () => {
    acting.requestIds = [request('handoff', 'a'), request('handoff', 'b')]
    await settleBotRequestTurn(runtime, 'docs-session')
    expect(mailToRanger()).toHaveLength(2)
  })

  it("settles no turn outside a bot's home", async () => {
    acting.requestIds = [request()]
    await settleBotRequestTurn(runtime, 'someone-else')
    expect(mailToRanger()).toEqual([])
  })

  it('leaves an answered request alone', async () => {
    const id = request('question')
    db.recordBotRequestOutcome(id, 'answered')
    acting.requestIds = [id]
    await settleBotRequestTurn(runtime, 'docs-session')
    expect(mailToRanger()).toEqual([])
  })

  it('tells the sender of requests a paused bot never read', async () => {
    const id = request()
    await dropUnreadBotRequests(runtime, 'docs', 'paused')
    expect(db.getBotRequestOutcome(id)).toBe('dropped')
    expect(mailToRanger()[0]?.body).toMatch(/^Docs was paused before it read your handoff/)
    await dropUnreadBotRequests(runtime, 'docs', 'paused')
    expect(mailToRanger()).toHaveLength(1)
  })

  it('sends nothing back for status: not when its turn ends, nor when the bot is paused or deleted', async () => {
    const id = request('status')
    acting.requestIds = [id]
    await settleBotRequestTurn(runtime, 'docs-session')
    await dropUnreadBotRequests(runtime, 'docs', 'paused')
    expect(db.getMessageById(id)?.read).toBe(1)
    expect(mailToRanger()).toEqual([])
    expect(notified).toEqual([])
    expect(() => botAnswerPayload(db, db.getMessageById(id)!)).toThrow('nothing to answer')
  })
})
