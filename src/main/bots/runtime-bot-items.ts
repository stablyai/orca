// The runtime's items host, wired to its stores, chat records and bots.
import type { Bot } from '../../shared/bot-types'
import type { BotChangeScope } from '../../shared/bots/bot-change-scope'
import { isOrcaSessionId } from '../../shared/agent-session/identity/orca-session-address'
import { allLinks } from '../external-conversations/external-conversation-links'
import type { RuntimeStore } from '../runtime/construction/runtime-store-contract'
import { createCanonicalOrcaSessionResolver } from '../runtime/orchestration/addressing/session-lineage/canonical-orca-session-id'
import { readAgentSessionRecordStore } from '../runtime/orchestration/addressing/session-lineage/structured-session-lineage'
import { BotItemsHost, type BotItemsHostDeps } from './bot-items-runtime'
import type { BotWorkRuntime } from './bot-work-runtime'

/** The runtime's items host, reading its store, records and bots per call. */
export function runtimeBotItems(runtime: {
  workRuntime: BotWorkRuntime
  db: BotItemsHostDeps['db']
  bots: () => readonly Bot[]
  store: () => RuntimeStore | null
  notify: (scope: BotChangeScope) => void
  sendMail: BotItemsHostDeps['sendMail']
}): BotItemsHost {
  const rootOf = (sessionId: string) => {
    const records = readAgentSessionRecordStore()
    return records && isOrcaSessionId(sessionId)
      ? createCanonicalOrcaSessionResolver(records)(sessionId)
      : sessionId
  }
  return new BotItemsHost({
    workRuntime: runtime.workRuntime,
    db: runtime.db,
    bots: runtime.bots,
    githubCache: () => runtime.store()?.getGitHubCache() ?? { pr: {}, issue: {} },
    automations: () => runtime.store()?.listAutomations?.() ?? [],
    chatTitle: (chatId) =>
      readAgentSessionRecordStore()?.getRecord(chatId)?.conversationName ?? null,
    chatExists: (chatId) => {
      const records = readAgentSessionRecordStore()
      return !records || Boolean(records.getRecord(chatId))
    },
    chatRoot: rootOf,
    threadChats: () => {
      const store = runtime.store()
      return store
        ? [...allLinks(store)].map(({ link }) => ({
            sessionId: link.sessionId,
            title: link.title ?? null
          }))
        : []
    },
    automationRunChats: () =>
      (runtime.store()?.listAutomationRuns?.() ?? []).flatMap((run) =>
        run.chatSessionId ? [run.chatSessionId] : []
      ),
    notify: runtime.notify,
    sendMail: runtime.sendMail
  })
}
