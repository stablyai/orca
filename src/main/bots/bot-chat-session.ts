// A bot's sessions are native chats in its home folder; its Chat is the one ongoing one, shared by the owner in Orca and by its direct messages.
import { OWNER_ACTS_FOR, type AutomationTriggeredBy } from '../../shared/bots/bot-acts-for'
import type { BotConversationActsFor } from '../runtime/orchestration/db/bot-requests/bot-conversation-acts-for-store'
import { randomUUID } from 'node:crypto'
import {
  AGENT_CHAT_PERMISSION_MODE_OPTION_ID,
  newChatPermissionMode
} from '../../shared/agent-launch/permissions/agent-chat-permission-mode'
import type { AgentMessageSource } from '../../shared/agent-session/journal/agent-session-message-source'
import type { Bot, BotAgent } from '../../shared/bot-types'
import { botOnSetup } from '../../shared/bots/bot-agent-setup'
import type { StructuredAgentSessionFirstMessage } from '../../shared/agent-session/lifecycle/operations/structured-agent-session-create'
import type { StructuredAgentSessionCreateOptions } from '../native-chat/agent-session-wire/acquisition/structured-agent-session-create-options'
import { agentSessionSendBodyFingerprint } from '../../shared/agent-session/requests/structured-agent-session-send-mutation'
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import { nameNewHome, type BotHomeHost } from './bot-home-chat-name'
export { BOT_CREATED_KICKOFF } from '../../shared/bot-created-kickoff'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-host'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-registry'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import {
  sendAgentTurn,
  type StructuredAgentTurnHost,
  type StructuredSessionTurnOutcome
} from '../runtime/orchestration/turn-delivery/send-agent-turn'
import { mintAgentSessionOperationId } from '../runtime/orchestration/mailbox/structured-pointer/structured-pointer-operation-id'
import { createStructuredAgentSessionForWorktree } from '../runtime/rpc/methods/structured-sessions/creation/structured-agent-session-create'
import { createBackgroundStructuredAgentSession } from '../runtime/rpc/methods/structured-agent-session-create-background'
import { runKeyedSerializedOperation } from '../../shared/concurrency/keyed-serialized-operations'
import {
  closeStructuredAgentSessionChild,
  type StructuredAgentSessionCloseOutcome
} from '../runtime/agent-session/lifecycle/structured-agent-session-close'
import type { BotController } from './bot-controller'
import { closeReplacedBotChat, dropReplacedChatMail } from './bot-chat-replacement'
import { carryQueuedMessages, type QueuedCarryHost } from './bot-chat-queued-carry'
import type { TookOverNotice } from '../../shared/native-chat/took-over-notice'
import type { AutomationRunMessage } from '../../shared/automations/automation-run-message'
import { botStartOptions } from './bot-start-options'
import { BotSessionRefusedError } from './bot-session-refused-error'
import { showBotSessionTab } from './bot-session-tab-show'
import { supportedStructuredSeedOptions } from '../runtime/agent-session/installation/structured-agent-runtime-metadata'

export type BotChatHost = StructuredAgentTurnHost & BotHomeHost & QueuedCarryHost

export type BotChatDependencies = {
  bots: Pick<BotController, 'list' | 'setChatSession'>
  /** Installs the native-chat host on first use. */
  host: () => Promise<BotChatHost>
  /** Creates `sessionId` at rest, with its tab, in the bot's home; its first message starts it. */
  createChat: (bot: Bot, sessionId: string) => Promise<void>
  /** Shows the Chat's tab again if it was closed. */
  showTab: (bot: Bot, sessionId: string) => Promise<void>
  /** Stops the Chat and removes its tab; its history stays. A close that cannot be proven keeps the tab. */
  closeChat: (
    sessionId: string
  ) => Promise<Pick<StructuredAgentSessionCloseOutcome, 'stopped' | 'reason'>>
  /** Ends the mail a replaced Chat never read; its senders hear the bot started a new Chat. */
  dropUnreadMail: (bot: Bot, replacedSessionId: string | null) => Promise<void>
}

/** What Orca writes on an automation run's message: where what the bot learns came from, who did
 *  the event, and the run itself for the chat's row. */
export type BotRunFields = {
  memorySource?: string
  triggeredBy?: AutomationTriggeredBy
  automationRun?: AutomationRunMessage
  images?: readonly { path: string }[]
}

/** A message to a bot's session, as native chat sends it. */
export function botMessageBody(
  text: string,
  { memorySource, triggeredBy, automationRun, images = [] }: BotRunFields = {}
): StructuredAgentSessionFirstMessage['body'] {
  const imageBlocks = images.map(({ path }) => ({ type: 'image-ref' as const, path }))
  return {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text }, ...imageBlocks],
    ...(memorySource ? { memorySource } : {}),
    ...(memorySource && triggeredBy ? { triggeredBy } : {}),
    ...(automationRun ? { origin: 'automation-run' as const, automationRun } : {})
  }
}

/** Who a bot chat's message is from: absent, a person; else another agent, or one of Orca's own turns. */
export type BotChatSender =
  | AgentMessageSource
  | 'bot-created'
  | 'card-answer'
  | { kind: 'took-over'; tookOver: TookOverNotice }

type Delivered = { sessionId: string; outcome: StructuredSessionTurnOutcome; fingerprint: string }

// One Chat change per bot at a time, so two first messages cannot each create a Chat.
const queues = new Map<string, Promise<void>>()

export function botChatSessions(deps: BotChatDependencies) {
  const requireBot = (botId: string): Bot => {
    const bot = deps.bots.list().find((entry) => entry.id === botId)
    if (!bot) {
      throw new Error('bot_not_found')
    }
    return bot
  }

  /** Retired first, so a failure leaves the bot pointing at its old Chat for the retry. */
  const replace = async (host: BotChatHost, bot: Bot): Promise<string> => {
    if (bot.chatSessionId && host.deps.store.getConversation(bot.chatSessionId)) {
      const closed = await deps.closeChat(bot.chatSessionId)
      if (!closed.stopped) {
        throw new Error(`bot_chat_close_failed: ${closed.reason ?? 'unknown'}`)
      }
    }
    const sessionId = randomUUID()
    await deps.createChat(bot, sessionId)
    // Saved before anything else can fail, so the bot never loses a Chat it made.
    await deps.bots.setChatSession(bot.id, sessionId)
    await carryQueuedMessages(host, bot.chatSessionId, sessionId)
    await deps.dropUnreadMail(bot, bot.chatSessionId)
    await nameNewHome(host, { ...bot, chatSessionId: sessionId }, bot.chatSessionId)
    return sessionId
  }

  /** The current Chat, or a new one when it is gone or runs another agent than the bot's. */
  const open = (host: BotChatHost, bot: Bot): Promise<string> | string => {
    const record = bot.chatSessionId ? host.deps.store.getConversation(bot.chatSessionId) : null
    return record?.provider === bot.agent ? record.sessionId : replace(host, bot)
  }

  const underLock = <T>(botId: string, work: (host: BotChatHost, bot: Bot) => Promise<T> | T) =>
    runKeyedSerializedOperation(queues, botId, async () =>
      work(await deps.host(), requireBot(botId))
    )

  const shown = async (bot: Bot, sessionId: string): Promise<string> => {
    await deps.showTab(bot, sessionId)
    return sessionId
  }

  /** The bot's Chat session id, created on first use, with its tab shown. */
  const ensure = (botId: string): Promise<string> =>
    underLock(botId, async (host, bot) => shown(bot, await open(host, bot)))

  /** Runs `work` on the Chat as `ensure` gives it (a closed tab would refuse mail), holding the bot's
   *  lock through it, so a reset cannot retire the Chat between choosing it and mailing it. */
  const withChat = <T>(botId: string, work: (sessionId: string) => Promise<T> | T): Promise<T> =>
    underLock(botId, async (host, bot) => work(await shown(bot, await open(host, bot))))

  /** Starts a new Chat; the old conversation stops and leaves the tab bar but stays in history. */
  const reset = (botId: string): Promise<string> =>
    underLock(botId, async (host, bot) => shown(bot, await replace(host, bot)))

  const deliver = async (
    host: BotChatHost,
    /** Sends the turn; the lock is released once it is admitted. */
    turnHost: StructuredAgentTurnHost,
    botId: string,
    sessionId: string,
    text: string,
    from?: BotChatSender,
    run?: BotRunFields
  ): Promise<Delivered> => {
    const sender =
      from === 'bot-created' || from === 'card-answer'
        ? { origin: from }
        : from?.kind === 'took-over'
          ? { origin: 'took-over' as const, tookOver: from.tookOver }
          : from
            ? { from }
            : {}
    const body = { ...botMessageBody(text, run), ...sender }
    const outcome = await sendAgentTurn({
      kind: 'structured-session',
      host: turnHost,
      sessionId,
      callerKey: `bot-chat:${botId}`,
      turn: {
        body,
        ...(from ? {} : { personsMessage: true }),
        operationId: mintAgentSessionOperationId(Date.now()),
        expectedRuntimeFence: host.deps.store.requireWritableRecord(sessionId).lease.runtimeFence,
        delivery: 'queue'
      }
    })
    return { sessionId, outcome, fingerprint: agentSessionSendBodyFingerprint(sessionId, body) }
  }

  /** Holds the bot's lock through admission only: the agent's start and the dispatch settle after it,
   *  so opening the Chat, or the next send, never waits on a starting agent. */
  const deliverUnderLock = (
    botId: string,
    work: (host: BotChatHost, bot: Bot, admitting: StructuredAgentTurnHost) => Promise<Delivered>
  ): Promise<Delivered> => {
    let delivered: Promise<Delivered> | undefined
    return underLock(botId, async (host, bot) => {
      let admitted = (): void => {}
      const admission = new Promise<void>((resolve) => (admitted = resolve))
      const admitting: StructuredAgentTurnHost = {
        send: (...args) => host.send(...args).finally(admitted),
        waitForSendSettlement: (...args) => host.waitForSendSettlement(...args)
      }
      delivered = work(host, bot, admitting)
      await Promise.race([admission, delivered])
    }).then(() => delivered!)
  }

  /** Held through admission, so a reset cannot retire the Chat between choosing and sending. Queues
   *  behind a running turn. `from` is absent for a person; `bot-created` is Orca's own first turn;
   *  `card-answer` is an owner's click on a card, which the chat draws as nothing; `took-over` is
   *  Orca's turn handing the bot a workspace.
   *  Returns the Chat it went to, and the fingerprint of the body it sent, which a queued card keeps
   *  until it is edited. */
  const send = (
    botId: string,
    text: string,
    from?: BotChatSender,
    run?: BotRunFields
  ): Promise<Delivered> =>
    deliverUnderLock(botId, async (host, bot, admitting) =>
      deliver(host, admitting, botId, await open(host, bot), text, from, run)
    )

  /** As `sendToChat`, into another of the bot's chats the caller already checked takes mail. */
  const sendToSession = (
    botId: string,
    sessionId: string,
    text: string,
    run?: BotRunFields,
    from?: BotChatSender
  ): Promise<Delivered> =>
    deliverUnderLock(botId, async (host, _bot, admitting) =>
      deliver(host, admitting, botId, sessionId, text, from, run)
    )

  return { ensure, reset, withChat, sendToChat: send, sendToSession }
}

/** The selector native chat resolves a bot's home folder workspace by. */
export function botWorkspaceSelector(bot: Pick<Bot, 'folderWorkspaceId'>): string {
  return `id:${folderWorkspaceKey(bot.folderWorkspaceId)}`
}

/** Installs the native-chat host on first use. */
export async function requireStructuredHost(
  runtime: Pick<OrcaRuntimeService, 'ensureStructuredAgentSessionHost'>
): Promise<StructuredAgentSessionHost> {
  await runtime.ensureStructuredAgentSessionHost()
  const installed = getStructuredAgentSessionHost()
  if (!installed) {
    throw new Error('structured_sessions_unavailable')
  }
  return installed
}

/** A new native chat in the bot's home, through native chat's own create, on the bot's agent (and its
 *  model, options and permission override, if any); the launch adds the preamble. With `message`, that message starts it,
 *  under the caller's id so its turn can be found. A `background` one (a thread's or a run's) gets no
 *  tab; it waits in the bot's Activity. */
export async function startBotSession(
  runtime: OrcaRuntimeService,
  bot: Bot,
  input: {
    sessionId?: string
    message?: { text: string; clientMessageId: string; run?: BotRunFields }
    background?: true
    /** Whom the conversation acts for, recorded before it starts; unrecorded, its first message says. */
    actsFor?: BotConversationActsFor
  } & Pick<StructuredAgentSessionCreateOptions, 'beforeFirstMessage' | 'beforeDelivery'> = {}
): Promise<string> {
  const sessionId = input.sessionId ?? randomUUID()
  if (input.actsFor) {
    runtime.getOrchestrationDb().recordBotConversationActsFor(sessionId, input.actsFor)
  }
  const permissionMode = bot.permissionMode && newChatPermissionMode(bot.agent, bot.permissionMode)
  // A model the agent no longer lists still goes through: the agent's own failure names it, as for any chat.
  const saved = botStartOptions(
    () => runtime.requireStore().getSettings(),
    bot,
    input.background === true
  )
  const launch = supportedStructuredSeedOptions(bot.agent, saved)
  const dropped = Object.keys(saved).filter((key) => !(key in launch))
  if (dropped.length) {
    console.warn(
      `[bots] ${bot.agent} no longer offers ${dropped.join(', ')}; starting without them`
    )
  }
  const options = {
    ...launch,
    ...(permissionMode ? { [AGENT_CHAT_PERMISSION_MODE_OPTION_ID]: permissionMode } : {})
  }
  const host = () => requireStructuredHost(runtime)
  const create = input.background
    ? createBackgroundStructuredAgentSession
    : createStructuredAgentSessionForWorktree
  const created = await create({
    runtime,
    ensureHost: host,
    caller: { callerKey: `bot:${bot.id}` },
    envelope: {
      sessionId,
      clientOperationId: mintAgentSessionOperationId(Date.now()),
      expectedRuntimeFence: null,
      payloadFingerprint: ''
    },
    worktree: botWorkspaceSelector(bot),
    agent: bot.agent,
    // A picked model replaces the default selection, so a default effort for another model never rides along.
    // Background work always replaces it: the chat defaults hold the owner's last pick in any chat.
    ...(launch.model || input.background
      ? { optionsMode: 'replace-model-selection' as const }
      : {}),
    ...(Object.keys(options).length || input.background ? { options } : {}),
    ...(input.message
      ? {
          firstMessage: {
            clientMessageId: input.message.clientMessageId,
            body: botMessageBody(input.message.text, input.message.run)
          }
        }
      : {}),
    beforeFirstMessage: input.beforeFirstMessage,
    beforeDelivery: input.beforeDelivery,
    atRest: true,
    activate: false
  })
  // An at-rest chat whose tab was unconfirmed still exists, and showing it publishes the tab again;
  // a first message would stay undelivered, so that start fails.
  if (!created.ok && (input.message || !(await host()).deps.store.getConversation(sessionId))) {
    throw new BotSessionRefusedError(bot.agent, created.refusal)
  }
  return sessionId
}

/** Stops a bot's conversation and removes its tab; its history stays. */
export function closeBotSession(
  runtime: OrcaRuntimeService,
  sessionId: string
): ReturnType<typeof closeStructuredAgentSessionChild> {
  return closeStructuredAgentSessionChild(sessionId, { runtime })
}

/** The bot as a chat on `agent` runs it: another agent starts on its own defaults, since the bot's
 *  launch belongs to its agent. */
export function botOnAgent(bot: Bot, agent: BotAgent | undefined): Bot {
  return agent && agent !== bot.agent ? botOnSetup(bot, { agent }) : bot
}

export function runtimeBotChats(runtime: OrcaRuntimeService) {
  return botChatSessions({
    bots: runtime.bots,
    host: () => requireStructuredHost(runtime),
    createChat: async (bot, sessionId) => {
      await startBotSession(runtime, bot, { sessionId, actsFor: { actsFor: [...OWNER_ACTS_FOR] } })
    },
    showTab: (bot, sessionId) => showBotSessionTab(runtime, bot, sessionId),
    closeChat: (sessionId) => closeReplacedBotChat(runtime, sessionId),
    dropUnreadMail: (bot, replaced) => dropReplacedChatMail(runtime, bot.id, replaced)
  })
}
