import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { BotRequestRecord } from '../../../../../bots/bot-request-view'
import type { StructuredAgentSessionQuestionRest } from '../../../../../native-chat/agent-session-wire/observations/structured-agent-session-turn-completion-feed'
import { botAnswerPayload, settleBotRequestTurn } from './bot-request-outcome'
import {
  reconcileBotRequestTakes,
  reconcileBotRequestTakesAtStartup
} from './bot-request-take-reconcile'
import { installSenderHost, removeSenderHost } from './bot-request-sender-host.test-fixture'
import { CheckMailReconciliation } from './check-mail-reconciliation'

const acting = vi.hoisted((): { requestIds: string[] } => ({ requestIds: [] }))
vi.mock('./bot-recipient', () => ({
  readBotTurn: async () => ({
    turn: { rootItemId: 'i', askers: [], request: null, requestIds: acting.requestIds },
    conversation: null
  })
}))
vi.mock('../../../../../bots/bot-session-tabs', () => ({
  botOfSession: (_bots: unknown, sessionId: string) =>
    sessionId === CHAT ? { id: 'docs', agent: 'codex' } : null
}))

const ASKER = 'orca_session_id:11111111-1111-4111-8111-111111111111'
const CHAT = '22222222-2222-4222-8222-222222222222'
const OTHER_CHAT = '33333333-3333-4333-8333-333333333333'

const record: BotRequestRecord = {
  fromBotId: 'ranger',
  fromBotName: 'Ranger',
  toBotId: 'docs',
  toBotName: 'Docs',
  purpose: 'question',
  depth: 1,
  askers: [{ kind: 'owner' }],
  request: null,
  conversation: null
}

describe('an agent question owes its asker one outcome', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let rest: StructuredAgentSessionQuestionRest
  let offered: Set<string>
  let continues: boolean | null
  const reader = {
    readQuestionRest: async () => rest,
    restartHolds: async () => new Set(offered),
    willContinue: async () => continues
  }

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    acting.requestIds = []
    rest = { kind: 'rest', outcome: 'success' }
    offered = new Set()
    continues = false
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these functions read only the db, the agent list and the mail nudge.
    runtime = {
      getOrchestrationDb: () => db,
      getOpenOrchestrationDb: () => db,
      getExistingOrchestrationDb: () => db,
      bots: { list: () => [{ id: 'docs' }] },
      notifyMessageArrived: () => undefined,
      getLiveTerminalPaneKey: () => null,
      readMachineName: () => 'Mac',
      orchestrationSenderNames: {
        sender: () => ({ name: 'Docs', party: { orcaSessionId: null } })
      },
      ensureStructuredAgentSessionHost: async () => installSenderHost([ASKER.split(':')[1]])
    } as unknown as OrcaRuntimeService
  })
  afterEach(() => {
    removeSenderHost()
    db.close()
  })

  function ask(input: { newRule?: boolean; sendKey?: string; subject?: string } = {}): string {
    const admitted = db.admitBotRequest({
      rootKey: `root-${Math.random()}`,
      ...(input.sendKey ? { sendKey: input.sendKey } : {}),
      fromBotId: 'ranger',
      toBotId: 'docs',
      purpose: 'question',
      depth: 1,
      record: JSON.stringify(record),
      debtRule: input.newRule ?? true,
      message: {
        from: ASKER,
        to: `orca_session_id:${CHAT}`,
        subject: input.subject ?? 'is the build green?',
        type: 'question'
      }
    })
    if (admitted.kind !== 'sent') {
      throw new Error('not admitted')
    }
    return admitted.message.id
  }

  /** The chat takes it whole, as custody does when its journal accepts the mail. */
  function take(id: string, sessionId = CHAT, by: 'agent' | 'person' = 'agent'): void {
    db.reserveStructuredMailSend({
      mailbox_handle: `orca_session_id:${CHAT}`,
      message_id: id,
      session_id: sessionId,
      operation_id: `op-${id}-${sessionId}`,
      minted_at_ms: 1
    })
    db.retireStructuredMailSend(
      {
        mailbox_handle: `orca_session_id:${CHAT}`,
        message_id: id,
        session_id: sessionId,
        operation_id: `op-${id}-${sessionId}`,
        minted_at_ms: 1
      },
      true,
      by
    )
  }

  const notices = () =>
    db.getAllMessagesForHandle(ASKER).toSorted((a, b) => a.sequence - b.sequence)

  it('tells the asker once when the chat rests unanswered, even with a worker of its own open', async () => {
    // The incident: an unrelated worker this chat started is still open, and two questions come in.
    db.db
      .prepare(
        `INSERT INTO dispatch_contexts (id, task_id, status, creator_orca_session_id)
         VALUES ('ctx_open', 'task-1', 'dispatched', ?)`
      )
      .run(CHAT)
    const first = ask({ subject: 'review A' })
    const second = ask({ subject: 'review B' })
    take(first)
    take(second)
    await reconcileBotRequestTakes(runtime, CHAT, reader)
    await reconcileBotRequestTakes(runtime, CHAT, reader)
    expect(notices().map((mail) => mail.subject)).toEqual(['Re: review A', 'Re: review B'])
    expect(db.getBotRequestOutcome(first)).toBe('unanswered')
    expect(db.getBotRequestOutcome(second)).toBe('unanswered')
  })

  it('waits while the chat works, will be continued after a usage limit, or awaits a Continue', async () => {
    const id = ask()
    take(id)
    rest = { kind: 'busy' }
    await reconcileBotRequestTakes(runtime, CHAT, reader)
    continues = true
    for (const state of [{ kind: 'rest', outcome: 'failure' }, { kind: 'closed' }] as const) {
      rest = state
      await reconcileBotRequestTakes(runtime, CHAT, reader)
    }
    continues = false
    offered.add(CHAT)
    await reconcileBotRequestTakes(runtime, CHAT, reader)
    expect(notices()).toEqual([])
    offered.clear()
    await reconcileBotRequestTakes(runtime, CHAT, reader)
    expect(notices()).toHaveLength(1)
  })

  it('tells a stopped turn with no recorded outcome, and a closed chat', async () => {
    const stopped = ask({ subject: 'stopped' })
    take(stopped)
    rest = { kind: 'rest', outcome: null }
    await reconcileBotRequestTakes(runtime, CHAT, reader)
    const closed = ask({ subject: 'closed' })
    take(closed)
    rest = { kind: 'closed' }
    await reconcileBotRequestTakes(runtime, CHAT, reader)
    expect(notices().map((mail) => mail.subject)).toEqual(['Re: stopped', 'Re: closed'])
  })

  it('tells nothing for a question answered before the chat rested, and keeps a late answer', async () => {
    const answered = ask({ subject: 'answered' })
    take(answered)
    botAnswerPayload(db, db.getMessageById(answered)!)
    const late = ask({ subject: 'late' })
    take(late)
    await reconcileBotRequestTakes(runtime, CHAT, reader)
    expect(notices().map((mail) => mail.subject)).toEqual(['Re: late'])
    expect(JSON.parse(botAnswerPayload(db, db.getMessageById(late)!)!).requestId).toBe(late)
    expect(db.getBotRequestOutcome(late)).toBe('answered')
    expect(db.listOpenBotRequestTakes(CHAT)).toEqual([])
  })

  it('tells nothing from a rest read before another chat took the question', async () => {
    const id = ask()
    take(id)
    reader.readQuestionRest = async () => {
      take(id, OTHER_CHAT)
      return rest
    }
    try {
      await reconcileBotRequestTakes(runtime, CHAT, reader)
    } finally {
      reader.readQuestionRest = async () => rest
    }
    expect(notices()).toEqual([])
    expect(db.listOpenBotRequestTakes(OTHER_CHAT).map((row) => row.message_id)).toEqual([id])
  })

  it('tells the asker at once when the owner withdrew it unread, whatever the chat does', async () => {
    const id = ask()
    take(id, CHAT, 'person')
    rest = { kind: 'busy' }
    await reconcileBotRequestTakes(runtime, CHAT, reader)
    expect(notices()).toHaveLength(1)
    expect(db.getBotRequestOutcome(id)).toBe('dropped')
  })

  it('leaves earlier-rule questions to the turn end, and new-rule ones out of it', async () => {
    const legacy = ask({ newRule: false, subject: 'legacy' })
    const current = ask({ subject: 'current' })
    take(legacy)
    take(current)
    acting.requestIds = [legacy, current]
    await settleBotRequestTurn(runtime, CHAT)
    expect(notices().map((mail) => mail.subject)).toEqual(['Re: legacy'])
    await reconcileBotRequestTakesAtStartup(runtime, reader)
    expect(notices().map((mail) => mail.subject)).toEqual(['Re: legacy', 'Re: current'])
  })

  it('refuses the same send again once it went unanswered', async () => {
    const id = ask({ sendKey: 'turn-1:docs:question:same' })
    take(id)
    await reconcileBotRequestTakes(runtime, CHAT, reader)
    expect(
      db.botRequestBlocked({ sendKey: 'turn-1:docs:question:same', purpose: 'question' })
    ).toEqual({
      kind: 'unanswered',
      messageId: id
    })
  })

  it('keeps a post where the asker asked as posted after the notice', async () => {
    const id = ask()
    take(id)
    await reconcileBotRequestTakes(runtime, CHAT, reader)
    expect(db.recordBotRequestOutcome(id, 'posted')).toBe(true)
    expect(db.getBotRequestOutcome(id)).toBe('posted')
  })

  it("queues a paired computer's notice with its outcome, once its way back is filed", async () => {
    const id = ask({ newRule: false })
    take(id)
    await reconcileBotRequestTakes(runtime, CHAT, reader)
    expect(db.getBotRequestOutcome(id)).toBeNull()
    db.linkPeerMailMessage({
      conversationId: 'conv-1',
      peerFingerprint: 'peer',
      messageId: id,
      senderLabel: 'Ranger on Mac'
    })
    expect(db.adoptBotRequestDebtRule(id)).toBe(CHAT)
    await reconcileBotRequestTakes(runtime, CHAT, reader)
    expect(db.getBotRequestOutcome(id)).toBe('unanswered')
    expect(
      db.db
        .prepare("SELECT count(*) AS n FROM federation_relay_items WHERE dispatch_id = 'conv-1'")
        .get()
    ).toEqual({ n: 1 })
  })

  it('leaves a question a terminal checked to the earlier rule', () => {
    const id = ask()
    db.noteBotRequestsChecked([id], null)
    expect(db.getBotRequest(id)?.debt_rule).toBeNull()
    expect(db.listSessionsWithOpenBotRequestTakes()).toEqual([])
  })

  it('names the request in its notice, which a shared thread cannot', async () => {
    const id = ask()
    take(id)
    await reconcileBotRequestTakes(runtime, CHAT, reader)
    expect(JSON.parse(notices()[0]!.payload!)).toMatchObject({ requestId: id })
  })

  it("keeps the question owed while Orca can't tell whether it continues the chat, then tells", async () => {
    vi.useFakeTimers()
    try {
      const id = ask()
      take(id)
      rest = { kind: 'rest', outcome: 'failure' }
      continues = null
      await reconcileBotRequestTakes(runtime, CHAT, reader)
      expect(notices()).toEqual([])
      continues = false
      await vi.advanceTimersByTimeAsync(30_000)
      expect(notices()).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the question owed while the chat its asker was cleared into cannot be read yet', async () => {
    const asker = ASKER.split(':')[1]!
    runtime.ensureStructuredAgentSessionHost = async () =>
      installSenderHost([asker], undefined, { [asker]: '44444444-4444-4444-8444-444444444444' })
    const id = ask()
    take(id)
    await reconcileBotRequestTakes(runtime, CHAT, reader)
    expect(db.getBotRequestOutcome(id)).toBeNull()
    expect(db.listOpenBotRequestTakes(CHAT).map((row) => row.message_id)).toEqual([id])
  })

  it('opens no database on a profile that never used orchestration', async () => {
    const getOrchestrationDb = vi.fn(() => db)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the same test runtime, with no database this run opened.
    const fresh = {
      ...runtime,
      getOrchestrationDb,
      getOpenOrchestrationDb: () => null
    } as unknown as OrcaRuntimeService
    await reconcileBotRequestTakes(fresh, CHAT, reader)
    expect(getOrchestrationDb).not.toHaveBeenCalled()
  })

  it("wakes the checking chat's decision once its check commits the take", async () => {
    const id = ask()
    const woke: string[] = []
    db.botRequestTakenListener = (sessionId) => woke.push(sessionId)
    const check = new CheckMailReconciliation(runtime, db, undefined, CHAT)
    try {
      await check.takeDirect({
        selected: [db.getMessageById(id)!],
        revalidate: () => undefined,
        respond: (messages) => messages
      })
    } finally {
      check.dispose()
    }
    expect(db.listOpenBotRequestTakes(CHAT).map((row) => row.message_id)).toEqual([id])
    expect(woke).toEqual([CHAT])
  })
})
