import type { Bot } from '../../shared/bot-types'
import type { BotChangeScope } from '../../shared/bots/bot-change-scope'
import type { BotItemAutomations, BotItemGitHubCache } from './bot-items-link-join'
import type { BotItemMail } from './bot-items-schema'
import type { BotWorkRuntime } from './bot-work-runtime'
import type { BotsDbWorkerClient } from './db-worker/bots-db-worker-client'

/** What a host's bot items are served from. */
export type BotItemsHostDeps = {
  workRuntime: BotWorkRuntime
  /** The bots DB worker the store's SQL runs in. */
  db: Pick<BotsDbWorkerClient, 'items' | 'dispose'>
  bots: () => readonly Bot[]
  /** The host's GitHub PR and issue caches: the desktop's, read on use, never a GitHub call. */
  githubCache: BotItemGitHubCache
  automations: BotItemAutomations
  chatTitle: (chatId: string) => string | null
  /** False only when the chat records were read and this chat's is gone; unread is not gone. */
  chatExists: (chatId: string) => boolean
  /** A chat's lineage root: the id `bot chats` lists, which a /clear keeps. */
  chatRoot: (sessionId: string) => string
  /** Connector threads' chats, by the session each link names. */
  threadChats: () => readonly { sessionId: string; title: string | null }[]
  /** Automation runs' chats. */
  automationRunChats: () => readonly string[]
  notify: (scope: BotChangeScope) => void
  /** Stores a write's mail for its items' chat; true once nothing is owed. */
  sendMail: (mail: BotItemMail) => Promise<boolean>
}
