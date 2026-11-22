import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { BotRequestRecord } from '../../../../../bots/bot-request-view'
import type { MailTaker } from '../../../../orchestration/db/messages/mail-taker'
import {
  botAnswerPayload,
  dropUnreadBotRequests,
  noteBotRequestPost,
  settleBotRequestFailure,
  settleBotRequestTurn
} from './bot-request-outcome'
import { installSenderHost, removeSenderHost } from './bot-request-sender-host.test-fixture'
import { botQuestionNotices } from './bot-question-notices'
import { startRestingQuestionReconciler } from '../../../../orchestration/mailbox/questions/question-reconciler.test-fixture'
import type { AgentSessionFailureFact } from '../../../../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../../../../shared/agent-session/failures/agent-session-failure-words'
import type { StructuredAgentSessionRequestFailure } from '../../../../../native-chat/agent-session-wire/observations/structured-agent-session-request-failures'

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
    sessionId === 'docs-session' ? { id: 'docs', agent: 'codex' } : null
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
      // As the real nudge does: it routes mail in its own transaction.
      notifyMessageArrived: (to: string) => {
        if (db.db.isTransaction) {
          throw new Error('cannot start a transaction within a transaction')
        }
        notified.push(to)
      },
      getLiveTerminalPaneKey: () => null,
      ensureStructuredAgentSessionHost: async () =>
        installSenderHost(['11111111-1111-4111-8111-111111111111'])
    } as unknown as OrcaRuntimeService
  })
  afterEach(() => {
    removeSenderHost()
    db.close()
  })

  function request(
    purpose: 'status' | 'handoff' | 'question' = 'handoff',
    root = 'root',
    askers: BotRequestRecord['askers'] = record.askers
  ): string {
    const admitted = db.admitBotRequest({
      rootKey: `${root}-${purpose}`,
      fromBotId: 'ranger',
      toBotId: 'docs',
      purpose,
      depth: 1,
      record: JSON.stringify({ ...record, purpose, askers }),
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

  it('settles each unanswered handoff once and wakes the sender for each', async () => {
    const first = request('handoff', 'a')
    const second = request('handoff', 'b')
    acting.requestIds = [first, second]
    await settleBotRequestTurn(runtime, 'docs-session')
    await settleBotRequestTurn(runtime, 'docs-session')

    expect(mailToRanger()).toHaveLength(2)
    expect(db.getBotRequestOutcome(first)).toBe('unanswered')
    expect(db.getBotRequestOutcome(second)).toBe('unanswered')
    expect(notified).toEqual([
      'orca_session_id:11111111-1111-4111-8111-111111111111',
      'orca_session_id:11111111-1111-4111-8111-111111111111'
    ])
  })

  it('leaves a question to whoever took it: the turn that read it ending tells no one', async () => {
    const question = request('question')
    acting.requestIds = [question]
    await settleBotRequestTurn(runtime, 'docs-session')
    expect(mailToRanger()).toEqual([])
    expect(db.getBotRequestOutcome(question)).toBeNull()
  })

  it('records an unanswered outcome only with its notice', async () => {
    const id = request('handoff')
    acting.requestIds = [id]
    vi.spyOn(db, 'insertMessage').mockImplementationOnce(() => {
      throw new Error('disk full')
    })

    await expect(settleBotRequestTurn(runtime, 'docs-session')).rejects.toThrow('disk full')
    expect(db.getBotRequestOutcome(id)).toBeNull()

    await settleBotRequestTurn(runtime, 'docs-session')
    expect(db.getBotRequestOutcome(id)).toBe('unanswered')
    expect(mailToRanger()).toHaveLength(1)
  })

  it("leaves a request open while its sender's /clear successor can't be read yet", async () => {
    const id = request('handoff')
    acting.requestIds = [id]
    runtime.ensureStructuredAgentSessionHost = async () =>
      installSenderHost(['11111111-1111-4111-8111-111111111111'], undefined, {
        '11111111-1111-4111-8111-111111111111': '33333333-3333-4333-8333-333333333333'
      })

    await settleBotRequestTurn(runtime, 'docs-session')
    expect(db.getBotRequestOutcome(id)).toBeNull()

    // Once the successor's record is readable, the sender is told there.
    runtime.ensureStructuredAgentSessionHost = async () =>
      installSenderHost(
        ['11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-333333333333'],
        undefined,
        { '11111111-1111-4111-8111-111111111111': '33333333-3333-4333-8333-333333333333' }
      )
    await settleBotRequestTurn(runtime, 'docs-session')
    expect(db.getBotRequestOutcome(id)).toBe('unanswered')
    expect(notified).toHaveLength(1)
  })

  it("says a failed turn failed and why, not that the bot read the owner's handoff", async () => {
    const id = request('handoff', 'root', [{ kind: 'owner' }])
    acting.requestIds = [id]
    // The completion of a failed turn is left to the failure, which knows why.
    await settleBotRequestTurn(runtime, 'docs-session', { outcome: 'failure' })
    expect(mailToRanger()).toEqual([])
    await settleBotRequestFailure(
      runtime,
      failedTurn({
        kind: 'modelUnavailable',
        account: 'system',
        detail: { text: 'astra', audience: 'log' }
      })
    )
    expect(mailToRanger().map((mail) => mail.body)).toEqual([
      "Docs's turn failed: Codex couldn't use astra. Pick another model and send again. It ended without answering your handoff, so do it yourself or tell your owner that Docs couldn't take it."
    ])
    expect(db.getBotRequestOutcome(id)).toBe('unanswered')
  })

  it("says a failed turn Orca continues after the limit resets isn't the sender's to redo", async () => {
    const id = request('handoff', 'root', [{ kind: 'owner' }])
    acting.requestIds = [id]
    const scheduled = { usageLimitContinue: { state: 'scheduled' as const } }
    runtime.ensureStructuredAgentSessionHost = async () =>
      installSenderHost(['11111111-1111-4111-8111-111111111111'], scheduled)
    installSenderHost(['11111111-1111-4111-8111-111111111111'], scheduled)
    await settleBotRequestFailure(runtime, failedTurn({ kind: 'usageLimitReached' }))
    expect(mailToRanger().map((mail) => mail.body)).toEqual([
      "Docs's turn failed: Codex hit its usage limit. Your handoff hasn't been handled yet; Docs continues on its own when the limit resets, so don't redo it."
    ])
  })

  it('passes on one answer to a request, and a late one after Orca said it went unanswered', async () => {
    const id = request()
    acting.requestIds = [id]
    await settleBotRequestTurn(runtime, 'docs-session')
    const original = db.getMessageById(id)!
    expect(botAnswerPayload(db, original)).toBeDefined()
    expect(() => botAnswerPayload(db, original)).toThrow('You already answered that request')
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

  describe('a question, told by whoever took it', () => {
    const DOCS: MailTaker = { kind: 'session', sessionId: '22222222-2222-4222-8222-222222222222' }
    const start = () => {
      const questions = startRestingQuestionReconciler(db, (taker, ids) =>
        botQuestionNotices(runtime, taker, ids)
      )
      onTestFinished(questions.stop)
      return questions.reconciler
    }
    const decided = async (reconciler: { settled(): Promise<void> }) => {
      for (let i = 0; i < 3; i++) {
        await new Promise((resolve) => setImmediate(resolve))
        await reconciler.settled()
      }
    }

    it('tells the asker once when the bot that read it stopped without answering', async () => {
      const reconciler = start()
      const id = request('question')
      db.markAsRead([id], DOCS)
      await decided(reconciler)
      reconciler.decideAll()
      await decided(reconciler)
      expect(mailToRanger().map((mail) => mail.body)).toEqual([
        "Docs ended its turn without answering your question, so do it yourself or tell Nora on Slack that Docs couldn't take it."
      ])
      expect(db.getBotRequestOutcome(id)).toBe('unanswered')
    })

    it('tells the asker a paused bot never read it', async () => {
      const reconciler = start()
      const id = request('question')
      await dropUnreadBotRequests(runtime, 'docs', 'paused')
      await decided(reconciler)
      expect(db.getMessageById(id)?.read).toBe(1)
      expect(mailToRanger()[0]?.body).toMatch(/^Docs was paused before it read your question/)
      expect(db.getBotRequestOutcome(id)).toBe('dropped')
    })

    it('tells the asker of a question being handed over when its bot is deleted', async () => {
      const reconciler = start()
      const id = request('question')
      db.reserveStructuredMailSend({
        mailbox_handle: 'orca_session_id:22222222-2222-4222-8222-222222222222',
        message_id: id,
        session_id: '22222222-2222-4222-8222-222222222222',
        operation_id: 'op-1',
        minted_at_ms: 1_700_000_000_000
      })
      await dropUnreadBotRequests(runtime, 'docs', 'deleted')
      await decided(reconciler)
      expect(mailToRanger()[0]?.body).toMatch(/^Docs was deleted before it read your question/)
    })

    it("waits while the asker's /clear successor can't be read, then tells it once it can", async () => {
      runtime.ensureStructuredAgentSessionHost = async () =>
        installSenderHost(['11111111-1111-4111-8111-111111111111'], undefined, {
          '11111111-1111-4111-8111-111111111111': '33333333-3333-4333-8333-333333333333'
        })
      const reconciler = start()
      const id = request('question')
      db.markAsRead([id], DOCS)
      await decided(reconciler)
      expect(db.getBotRequestOutcome(id)).toBeNull()

      runtime.ensureStructuredAgentSessionHost = async () =>
        installSenderHost(
          ['11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-333333333333'],
          undefined,
          { '11111111-1111-4111-8111-111111111111': '33333333-3333-4333-8333-333333333333' }
        )
      reconciler.decideAll()
      await decided(reconciler)
      expect(db.getBotRequestOutcome(id)).toBe('unanswered')
      expect(notified).toHaveLength(1)
    })
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

/** A turn that failed as a provider fails one: an accepted send, then a turn-scoped status row
 *  carrying the typed failure, worded as the chat writes it. */
function failedTurn(failure: AgentSessionFailureFact): StructuredAgentSessionRequestFailure {
  const turn = 'orca:turn-1'
  return {
    sessionId: 'docs-session',
    agent: 'codex',
    kind: 'turn',
    id: turn,
    outcome: 'failure',
    read: async () => ({
      sessionId: 'docs-session',
      cursor: { epoch: 'e', sequence: 3 },
      submissions: [],
      items: [
        {
          itemId: turn,
          revision: 2,
          sequence: 1,
          observedAt: 1,
          body: {
            kind: 'turn',
            turnId: 't1',
            state: 'completed',
            outcome: 'failure',
            completedAt: 2
          }
        },
        {
          itemId: 'orca:terminal-failure',
          revision: 1,
          sequence: 2,
          observedAt: 2,
          turnScope: { kind: 'turn', turnItemId: turn },
          body: {
            kind: 'status',
            ...agentSessionFailureWords(failure, { surface: 'row', agentName: 'Codex' })
          }
        }
      ]
    })
  }
}
