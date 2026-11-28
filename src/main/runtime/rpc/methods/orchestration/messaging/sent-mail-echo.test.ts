import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { botChat, runningTurnReads } from '../federation/sending-bot-turn.test-fixture'
import type { StructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/host/structured-agent-session-host'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import type { MessageType } from '../../../../orchestration/db/orchestration-records'
import type { RpcContext } from '../../../core'
import { ORCHESTRATION_METHODS } from '../orchestration'
import { noteSentMailInChat } from './sent-mail-echo'
import { sendPointToPointMessage } from './send-point-to-point'

type SentLine = { sessionId: string; messageId: string; text: string }

const state = vi.hoisted((): { lines: SentLine[]; host: StructuredAgentSessionHost | null } => ({
  lines: [],
  host: null
}))

vi.mock(
  '../../../../../native-chat/agent-session-wire/host/structured-agent-session-registry',
  () => ({
    getStructuredAgentSessionHost: () => state.host
  })
)

const CHAT = 'orca_session_id:11111111-1111-4111-8111-111111111111'
const CHAT_ID = CHAT.slice('orca_session_id:'.length)
const RECIPIENT = 'orca_session_id:22222222-2222-4222-8222-222222222222'
const RECIPIENT_ID = RECIPIENT.slice('orca_session_id:'.length)

/** The host a note writes through: every line it appends shows in `state.lines`. */
function noteHost(): StructuredAgentSessionHost {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a test double carrying only the host calls a chat note and a bot send read.
  return {
    deps: {
      store: {
        getConversation: (id: string) => (id === RECIPIENT_ID ? receiverRecord : null),
        listConversations: () => (receiverRecord ? [receiverRecord] : [])
      }
    },
    journalReads: runningTurnReads(undefined),
    conversation: async () => ({
      journal: { queuedMessages: { failureHolds: async () => false } }
    }),
    captureAgentStartDestination: async (sessionId: string) => ({ sessionId }),
    appendAgentStart: async (
      destination: { sessionId: string },
      line: { body: { text: string }; messageId: string }
    ) => {
      // The real journal names a row by this id, so repeating one writes one row.
      if (!state.lines.some((entry) => entry.messageId === line.messageId)) {
        state.lines.push({
          sessionId: destination.sessionId,
          messageId: line.messageId,
          text: line.body.text
        })
      }
      return true
    }
  } as unknown as StructuredAgentSessionHost
}

let receiverRecord: ReturnType<typeof botChat>['record'] | null = null

function runtimeStub(): OrcaRuntimeService {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a test double carrying only the runtime calls a send's note reads.
  return {
    notifyMessageArrived: () => {},
    orchestrationSenderNames: {
      sender: (address: string) => ({ name: address === RECIPIENT ? 'Docs' : null })
    }
  } as unknown as OrcaRuntimeService
}

describe('a chat noting the mail it sent', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService

  beforeEach(() => {
    state.lines = []
    state.host = noteHost()
    db = new OrchestrationDb(':memory:')
    runtime = runtimeStub()
  })

  afterEach(() => {
    db.close()
    state.host = null
  })

  function send(args: {
    from?: string
    to?: string
    type?: MessageType
    subject?: string
    body?: string
  }): { message: { id: string } } {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a question send stores one message and returns its receipt.
    return sendPointToPointMessage({
      params: {
        subject: args.subject ?? 'Review the migration plan',
        body: args.body ?? 'Please check the new flag.',
        type: args.type ?? 'question'
      },
      runtime,
      db,
      from: args.from ?? CHAT,
      to: args.to ?? RECIPIENT,
      dispatchId: undefined,
      messageRunId: undefined,
      senderPaneKey: undefined,
      legacyCoordinatorRunId: undefined,
      resolveProcessIncarnation: () => undefined,
      revalidateLegacyCoordinator: undefined,
      recordMutationReceipt: undefined,
      markWorkerDoneMutationEffectFree: undefined,
      withSendWarnings: (receipt) => receipt
    }) as { message: { id: string } }
  }

  it("notes a chat's question and a body excerpt as one sent row", async () => {
    const sent = send({})

    await flushWrites()

    expect(state.lines).toEqual([
      {
        sessionId: CHAT_ID,
        messageId: `mail-sent:${sent.message.id}`,
        text: 'Sent to Docs: Review the migration plan — Please check the new flag.'
      }
    ])
  })

  it("notes a chat's handoff too", async () => {
    send({ type: 'handoff', body: 'Take over the release check.' })

    await flushWrites()

    expect(state.lines.map((entry) => entry.text)).toEqual([
      'Sent to Docs: Review the migration plan — Take over the release check.'
    ])
  })

  it('leaves a worker handle send alone, since that sender has no chat here', async () => {
    send({ from: 'term_worker' })

    await flushWrites()

    expect(state.lines).toEqual([])
  })

  it('leaves mail a chat sends as status alone', async () => {
    send({ type: 'status' })

    await flushWrites()

    expect(state.lines).toEqual([])
  })

  it('writes once when the same message is noted again', async () => {
    const message = {
      id: 'msg_same',
      from_handle: CHAT,
      to_handle: RECIPIENT,
      subject: 'Review the migration plan',
      body: 'Please check the new flag.',
      type: 'question' as const
    }

    noteSentMailInChat(runtime, message)
    noteSentMailInChat(runtime, message)

    await flushWrites()

    expect(state.lines).toEqual([
      {
        sessionId: CHAT_ID,
        messageId: 'mail-sent:msg_same',
        text: 'Sent to Docs: Review the migration plan — Please check the new flag.'
      }
    ])
  })
})

describe('a send a bot request takes', () => {
  it('leaves the bot request its own card, never a sent row in the sender chat', async () => {
    state.lines = []
    const { bot, record } = botChat('Docs', RECIPIENT_ID)
    receiverRecord = record
    state.host = noteHost()
    const db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService(null, undefined, {})
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'ensureStructuredAgentSessionHost').mockResolvedValue(undefined)
    vi.spyOn(runtime, 'publishStructuredAgentSessionTab').mockResolvedValue(undefined)
    vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})
    vi.spyOn(runtime.bots, 'list').mockReturnValue([bot])
    vi.spyOn(runtime.bots, 'enabled').mockReturnValue(true)
    try {
      const send = ORCHESTRATION_METHODS.find((method) => method.name === 'orchestration.send')!
      await send.handler(
        { from: CHAT, to: RECIPIENT, subject: 'Review it', type: 'question' },
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a test double carrying only the context fields the send reads.
        {
          runtime,
          orchestrationCaller: {
            address: CHAT,
            terminalHandle: null,
            orcaSessionId: CHAT_ID,
            sessionId: CHAT_ID,
            paneKey: null
          }
        } as unknown as RpcContext
      )

      await flushWrites()

      expect(state.lines).toEqual([])
      const delivered = db.getUnreadMessages(RECIPIENT)
      expect(delivered).toHaveLength(1)
      expect(db.getBotRequest(delivered[0]!.id)).toMatchObject({ to_bot_id: bot.id })
    } finally {
      db.close()
      receiverRecord = null
      state.host = null
    }
  })
})

async function flushWrites(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}
