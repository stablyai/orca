// Shared by the bot mail tests: two bots on one host, their sessions and journals, and a send as one
// of their chats. Each test file mocks the modules below with these factories.
import type { BotConversationActsFor } from '../../../../orchestration/db/bot-requests/bot-conversation-acts-for-store'
import { vi, type Mock } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import { latestStructuredAgentSessionUserItem } from '../../../../../../shared/agent-session/requests/structured-agent-session-latest-request'
import type { Bot } from '../../../../../../shared/bot-types'
import type { RpcContext } from '../../../core'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationSessionCaller } from '../../../../orchestration/addressing/orchestration-caller-identity'
import type { createOrchestrationRpcHarness } from '../rpc-test-harness'
import { makeTestBot } from '../../../../../bots/bot.test-fixture'
import type * as RecipientRouting from './recipient-routing'

export const RANGER_THREAD = '11111111-1111-4111-8111-111111111111'
export const DOCS_CHAT = '22222222-2222-4222-8222-222222222222'
export const DOCS_THREAD = '33333333-3333-4333-8333-333333333333'
export const RANGER_CHAT = '44444444-4444-4444-8444-444444444444'
/** The conversation a teammate's request to Docs runs in. */
export const DOCS_REQUEST = '77777777-7777-4777-8777-777777777777'

export const sessionsOf: Record<string, string[]> = {
  ranger: [RANGER_THREAD, RANGER_CHAT],
  docs: [DOCS_CHAT, DOCS_THREAD, DOCS_REQUEST]
}
export const journals: Record<string, AgentJournalRenderItem[]> = {}
export const withChat: Mock<(botId: string, work: (sessionId: string) => unknown) => unknown> =
  vi.fn()
export const startBotSession: Mock<() => Promise<string>> = vi.fn(async () => DOCS_REQUEST)
export const closeBotSession: Mock<(sessionId: string) => Promise<unknown>> = vi.fn(async () => ({
  stopped: true
}))
export const setUserConversationName: Mock<(sessionId: string, title: string) => Promise<void>> =
  vi.fn(async () => undefined)
export const notes: string[] = []
/** The chat each note went to, in order. */
export const noteChats: (string | undefined)[] = []
/** Chats whose last turn failed, so they hold another agent's mail until their owner sends. */
export const failureHeldChats = new Set<string>()
/** Cards written into a chat, by session. */
export const cards: { sessionId: string | undefined; body: unknown }[] = []

export const botSessionTabsMock = {
  botOfSession: (bots: { list: () => Bot[] }, sessionId: string) =>
    bots.list().find((bot) => sessionsOf[bot.id]?.includes(sessionId)) ?? null
}
export const botChatSessionMock = {
  requireStructuredHost: async () => ({
    journalReads: async (sessionId: string) => {
      const items = journals[sessionId] ?? []
      return {
        operationWindow: async () => ({ complete: true, snapshot: { items, submissions: [] } }),
        promptItem: async (end: 'first' | 'last') =>
          latestStructuredAgentSessionUserItem(end === 'first' ? items.toReversed() : items)
      }
    },
    setUserConversationName
  }),
  runtimeBotChats: () => ({ withChat }),
  // Records whom the conversation acts for, as the real start does.
  startBotSession: async (
    runtime: OrcaRuntimeService,
    _bot: unknown,
    input?: { actsFor?: BotConversationActsFor }
  ) => {
    const sessionId = await startBotSession()
    if (input?.actsFor) {
      runtime.getOrchestrationDb().recordBotConversationActsFor(sessionId, input.actsFor)
    }
    return sessionId
  },
  closeBotSession: (_runtime: unknown, sessionId: string) => closeBotSession(sessionId)
}
export const botChatMailHoldMock = {
  chatHoldsAgentMail: async (_runtime: unknown, sessionId: string) =>
    failureHeldChats.has(sessionId)
}
export const botChatStatusLineMock = {
  noteInChat: (sessionId: string | undefined, text: string) => {
    noteChats.push(sessionId)
    notes.push(text)
  },
  writeInChat: (sessionId: string | undefined, body: unknown) => cards.push({ sessionId, body })
}
// Session records live in the native-chat host; these tests read every session as reachable.
export function recipientRoutingMock(actual: typeof RecipientRouting): typeof RecipientRouting {
  return {
    ...actual,
    resolveBareOrchestrationRecipient: (params) =>
      params.handle.startsWith('orca_session_id:')
        ? { ok: true, to: params.handle, runId: params.senderRunId }
        : actual.resolveBareOrchestrationRecipient(params),
    resolveReplyRecipient: (params) =>
      params.originalFrom.startsWith('orca_session_id:')
        ? { to: params.originalFrom, runId: params.originalRunId }
        : actual.resolveReplyRecipient(params)
  }
}

let sequence = 0
export function message(
  itemId: string,
  body: Record<string, unknown> = {}
): AgentJournalRenderItem {
  sequence += 1
  return {
    itemId,
    revision: 0,
    sequence,
    observedAt: sequence,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: itemId }], ...body }
  }
}

export function askedBy(userId: string, name: string, role: 'owner' | 'member' = 'member') {
  return {
    origin: 'connector',
    asker: { source: 'slack', userId, name, role, place: { kind: 'public_channel', id: 'C1' } }
  }
}

export function caller(sessionId: string): OrchestrationSessionCaller {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixed UUID test ids are Orca session ids.
  const id = sessionId as OrchestrationSessionCaller['sessionId']
  return {
    address: `orca_session_id:${sessionId}`,
    terminalHandle: null,
    paneKey: null,
    orcaSessionId: id,
    sessionId: id,
    workspaceId: 'w'
  }
}

/** Ranger and Docs on one host; Dana may ask Docs. Call in beforeEach. */
export function setupBotMail(h: ReturnType<typeof createOrchestrationRpcHarness>) {
  const { db, runtime } = h.setup(false)
  const bots = [
    makeTestBot({ id: 'ranger', name: 'Ranger', slack: { appId: 'A1', teamId: 'T1' } }),
    makeTestBot({
      id: 'docs',
      name: 'Docs',
      slack: { appId: 'A2', teamId: 'T1' },
      members: [{ id: 'U_DANA', name: 'Dana', source: 'slack', workspaceId: 'T1' }]
    })
  ]
  vi.spyOn(runtime.bots, 'list').mockImplementation(() => bots)
  vi.spyOn(runtime.bots, 'enabled').mockReturnValue(true)
  vi.spyOn(runtime, 'ensureStructuredAgentSessionHost').mockResolvedValue(undefined)
  vi.spyOn(runtime, 'listAutomationRuns').mockReturnValue([])
  const seam = {
    replyTarget: () => ({
      key: { source: 'slack', externalId: 'T1:C1:1712.1:UBOT' },
      turnId: 1,
      worktreeId: 'w'
    }),
    conversationTurn: vi.fn((_chats: unknown, _sessionId: string) => false)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the bot path reads only replyTarget and conversationTurn from the seam.
  const seamStub = seam as unknown as ReturnType<OrcaRuntimeService['getExternalConversationSeam']>
  vi.spyOn(runtime, 'getExternalConversationSeam').mockReturnValue(seamStub)
  vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})
  // A `--chat new` chat's tab, shown in the bot's home.
  const publishTab = vi.spyOn(runtime, 'publishStructuredAgentSessionTab').mockResolvedValue()
  startBotSession.mockClear()
  closeBotSession.mockClear()
  setUserConversationName.mockClear()
  notes.length = 0
  noteChats.length = 0
  failureHeldChats.clear()
  cards.length = 0
  withChat.mockReset()
  withChat.mockImplementation((_botId: string, work: (sessionId: string) => unknown) =>
    work(DOCS_CHAT)
  )
  for (const key of Object.keys(journals)) {
    delete journals[key]
  }
  const context = (from: string) =>
    ({ runtime, orchestrationCaller: caller(from) }) satisfies RpcContext
  const send = (from: string, params: Record<string, unknown>) =>
    h.call(
      'orchestration.send',
      { subject: 'update the install docs', from: `orca_session_id:${from}`, ...params },
      context(from)
    )
  // A receipt as JSON, so its fields read without a cast.
  const sent = async (from: string, params: Record<string, unknown>) =>
    JSON.parse(JSON.stringify(await send(from, params)))
  const reply = (from: string, params: Record<string, unknown>) =>
    h.call('orchestration.reply', params, context(from))
  return {
    db,
    runtime,
    bots,
    send,
    sent,
    reply,
    publishTab,
    conversationTurn: seam.conversationTurn
  }
}
