import { agentJournalSubmissionKey } from '../../shared/agent-session/journal/agent-session-journal-item-key'
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import { writeStructuredAgentSessionOrcaNote } from '../native-chat/agent-session-wire/structured-agent-session-orca-note'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { structuredSessionMailCustody } from '../runtime/orchestration/mailbox/routing/structured-session-mail-target'
import { sendAgentTurn } from '../runtime/orchestration/turn-delivery/send-agent-turn'
import { botMessageBody, requireStructuredHost, startBotSession } from './bot-chat-session'
import { BotThreadPosts, type BotThreadPost } from './bot-thread-posts'

const services = new WeakMap<
  OrcaRuntimeService,
  { posts: BotThreadPosts; account: () => string | null }
>()

export function postRuntimeBotThread(runtime: OrcaRuntimeService, input: BotThreadPost) {
  const service = services.get(runtime)
  const account = service?.account()
  if (!service || !account) {
    throw new Error('bot_thread_delivery_unavailable')
  }
  return service.posts.postToThread(account, input)
}

export function installBotThreadPosts(
  runtime: OrcaRuntimeService,
  account: () => string | null
): BotThreadPosts {
  const requireBot = (botId: string) => {
    const bot = runtime.bots.list().find((entry) => entry.id === botId)
    if (!bot) {
      throw new Error('bot_not_found')
    }
    return bot
  }
  const posts = new BotThreadPosts({
    account,
    database: () => runtime.getOrchestrationDb().db,
    openThread: async (botId, threadId) => {
      const host = await requireStructuredHost(runtime)
      const custody = structuredSessionMailCustody(threadId, runtime.getOrchestrationDb())
      if (custody === 'unverifiable') {
        throw new Error('The Orca conversation could not be read.')
      }
      const sessionId = typeof custody === 'object' ? custody.sessionId : null
      return sessionId &&
        host.deps.store.getConversation(sessionId)?.location.workspaceId ===
          folderWorkspaceKey(requireBot(botId).folderWorkspaceId)
        ? sessionId
        : null
    },
    ensureInbox: async (botId, threadId) => {
      const host = await requireStructuredHost(runtime)
      const bot = requireBot(botId)
      const record = host.deps.store.getConversation(threadId)
      if (!record) {
        await startBotSession(runtime, bot, { sessionId: threadId, background: true })
      } else if (record.location.workspaceId !== folderWorkspaceKey(bot.folderWorkspaceId)) {
        throw new Error('The Orca inbox belongs to a different bot.')
      }
      if (record?.conversationName !== 'Orca Inbox') {
        await host.setUserConversationName(threadId, 'Orca Inbox', 'rename')
      }
    },
    write: async (
      botId,
      { thread_id: sessionId, operation_id: operationId, wake, text },
      checkAccount
    ) => {
      const host = await requireStructuredHost(runtime)
      checkAccount()
      if (!wake) {
        await writeStructuredAgentSessionOrcaNote(host, sessionId, operationId, {
          kind: 'status',
          text
        })
        return agentJournalSubmissionKey(operationId)
      }
      const outcome = await sendAgentTurn({
        kind: 'structured-session',
        host,
        sessionId,
        callerKey: `post-to-thread:${botId}`,
        turn: {
          body: botMessageBody(text),
          operationId,
          delivery: 'queue',
          expectedRuntimeFence: host.deps.store.requireWritableRecord(sessionId).lease.runtimeFence,
          beforeRun: checkAccount
        }
      })
      if (outcome.kind === 'refused') {
        throw new Error(outcome.refusal.message)
      }
      return outcome.clientMessageId
    }
  })
  services.set(runtime, { posts, account })
  return posts
}
