import { describe, expect, it, vi } from 'vitest'
import type { AgentJournalSubmission } from '../../shared/agent-session/journal/agent-session-journal-types'
import type { StructuredSessionTurnOutcome } from '../runtime/orchestration/turn-delivery/send-agent-turn'
import { botAutomationSessions, runtimeBotAutomationSessions } from './bot-automation-sessions'
import * as BotChatSession from './bot-chat-session'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'

const { startBotSession } = BotChatSession
vi.mock('./bot-chat-session', async (original) => ({
  ...(await original<typeof BotChatSession>()),
  startBotSession: vi.fn(async () => 'run-session')
}))
import { makeTestBot } from './bot.test-fixture'

const bot = makeTestBot()

function submission(overrides: Partial<AgentJournalSubmission>): AgentJournalSubmission {
  return {
    clientMessageId: 'message-1',
    fence: 1,
    payloadFingerprint: '',
    dispatchState: 'accepted',
    providerItemId: null,
    reason: null,
    submittedAt: 1,
    resolvedAt: null,
    ...overrides
  }
}

function sessions(
  outcome: StructuredSessionTurnOutcome = {
    kind: 'sent',
    clientMessageId: 'm',
    submission: undefined
  }
) {
  const deps = {
    chats: {
      sendToChat: vi.fn(async () => ({ sessionId: 'chat-session', outcome, fingerprint: 'f' })),
      sendToSession: vi.fn(async (_botId: string, sessionId: string) => ({
        sessionId,
        outcome,
        fingerprint: 'f'
      }))
    },
    chatTakingMail: vi.fn(async (_bot: unknown, chatId: string) =>
      chatId === 'side-chat' ? { sessionId: 'side-chat-after-clear' } : null
    ),
    startSession: vi.fn(async () => 'new-session'),
    nameSession: vi.fn(async () => undefined),
    sendToGroupRoom: vi.fn(async (_bot: unknown, sessionId: string) => ({
      sessionId,
      clientMessageId: 'room-op',
      fingerprint: 'f'
    }))
  }
  return { deps, sessions: botAutomationSessions(deps) }
}

const OWNER = { actsFor: [{ kind: 'owner' as const }] }

describe('botAutomationSessions', () => {
  it('opens a new conversation started by the prompt and named for the run', async () => {
    const { deps, sessions: started } = sessions()

    const send = await started.startConversation(bot, {
      text: 'Summarize the night',
      title: 'Morning digest run 3',
      actsFor: OWNER
    })

    // The run's message is named, so the run reads only the turn it started.
    expect(send).toEqual({
      sessionId: 'new-session',
      clientMessageId: expect.any(String),
      fingerprint: expect.any(String)
    })
    expect(deps.startSession).toHaveBeenCalledExactlyOnceWith(
      bot,
      { text: 'Summarize the night', clientMessageId: send.clientMessageId },
      OWNER,
      // No session named beforehand: the start mints one.
      undefined
    )
    expect(deps.nameSession).toHaveBeenCalledExactlyOnceWith('new-session', 'Morning digest run 3')
  })

  it('runs in the chat an automation names, and refuses one that is gone instead of the Home Chat', async () => {
    const { deps, sessions: chats } = sessions()

    await expect(chats.sendToBotChat(bot, 'side-chat', 'Check the deploy')).resolves.toMatchObject({
      sessionId: 'side-chat-after-clear'
    })
    await expect(chats.sendToBotChat(bot, 'closed-chat', 'Check the deploy')).rejects.toThrow(
      'has no chat chat:closed-chat that takes mail'
    )
    expect(deps.chats.sendToSession).toHaveBeenCalledTimes(1)
    expect(deps.chats.sendToChat).not.toHaveBeenCalled()
  })

  it("runs in a group room by the bot's member session there, never its Home Chat", async () => {
    const { deps, sessions: chats } = sessions()
    await chats.sendToBotChat(bot, 'bot-group-member-1', 'Check progress', undefined, true)
    expect(deps.sendToGroupRoom).toHaveBeenCalledExactlyOnceWith(
      bot,
      'bot-group-member-1',
      'Check progress',
      undefined
    )
    expect(deps.chats.sendToChat).not.toHaveBeenCalled()
  })

  it("drops a wait's thread answer when its gone chat's run lands in the Home Chat", async () => {
    const { deps, sessions: chats } = sessions()
    const automationRun = {
      runId: 'run-1',
      automation: {
        id: 'wait-1',
        name: 'Run 1',
        enabled: true,
        nextRunAt: 0,
        updatedAt: 0,
        dtstart: 0,
        rrule: 'FREQ=DAILY',
        workspaceId: 'folder:f1'
      },
      trigger: 'event' as const,
      toConversation: true as const,
      instructionsLength: 0
    }

    await chats.sendToBotChat(bot, 'closed-chat', 'PR merged', { automationRun }, true)
    await chats.sendToBotChat(bot, 'side-chat', 'PR merged', { automationRun }, true)

    const { toConversation: _dropped, ...homeRun } = automationRun
    expect(deps.chats.sendToChat).toHaveBeenCalledExactlyOnceWith(bot.id, 'PR merged', undefined, {
      automationRun: homeRun
    })
    expect(deps.chats.sendToSession).toHaveBeenCalledExactlyOnceWith(
      bot.id,
      'side-chat-after-clear',
      'PR merged',
      { automationRun }
    )
  })

  it('keeps the session when naming it fails', async () => {
    const { deps, sessions: started } = sessions()
    deps.nameSession.mockRejectedValueOnce(new Error('rename failed'))
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await expect(
      started.startConversation(bot, { text: 'hi', title: 'run 1', actsFor: OWNER })
    ).resolves.toMatchObject({ sessionId: 'new-session' })
  })

  it('fails the launch when the Chat refuses or rejects the prompt', async () => {
    const refused = sessions({
      kind: 'refused',
      refusal: { code: 'agent_session_conflict', message: 'The chat is not open.' }
    })
    await expect(refused.sessions.sendToChat(bot, 'hi')).rejects.toThrow('The chat is not open.')

    const rejected = sessions({
      kind: 'sent',
      clientMessageId: 'm',
      submission: submission({ dispatchState: 'rejected', reason: 'The agent stopped.' })
    })
    await expect(rejected.sessions.sendToChat(bot, 'hi')).rejects.toThrow('The agent stopped.')
  })
})

describe("the runtime's automation sessions", () => {
  it("start a run's new conversation as background work, so it never takes the owner's last chat pick", async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a new conversation's start reaches only startBotSession.
    const started = runtimeBotAutomationSessions({
      bots: { list: () => [] }
    } as unknown as OrcaRuntimeService)

    await started.startConversation(bot, {
      text: 'Look',
      title: 'Look around',
      actsFor: OWNER
    })

    expect(startBotSession).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      bot,
      expect.objectContaining({ background: true, actsFor: OWNER })
    )
  })

  it("hand a scheduled run's opening-message check to the session start, which makes the call", async () => {
    vi.mocked(startBotSession).mockClear()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a new conversation's start reaches only startBotSession.
    const started = runtimeBotAutomationSessions({
      bots: { list: () => [] }
    } as unknown as OrcaRuntimeService)
    const beforeFirstMessage = vi.fn()

    await started.startConversation(bot, {
      text: 'Look',
      title: 'Look around',
      actsFor: OWNER,
      beforeFirstMessage
    })

    expect(startBotSession).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      bot,
      expect.objectContaining({ beforeFirstMessage })
    )
  })
})
