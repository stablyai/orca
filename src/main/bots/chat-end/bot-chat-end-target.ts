// Which of a bot's chats an end names: the whole /clear lineage behind the id `orca bot chats` prints,
// and the chats an end never touches (Home, group members, threads, Look around/Tidy-up runs).
import type { Bot } from '../../../shared/bot-types'
import { botOfHomeWorkspace } from '../../../shared/bots/bot-homes'
import { isBotGroupMemberSession } from '../../../shared/bots/bot-group'
import { isOrcaSessionId } from '../../../shared/agent-session/identity/orca-session-address'
import type { BotChatEndRefusal } from '../../../shared/bots/bot-chat-end'
import type { StructuredAgentSessionHost } from '../../native-chat/agent-session-wire/host/structured-agent-session-host'
import { createCanonicalOrcaSessionResolver } from '../../runtime/orchestration/addressing/session-lineage/canonical-orca-session-id'
import {
  readAgentSessionRecordStore,
  resolveLineageRunningSession
} from '../../runtime/orchestration/addressing/session-lineage/structured-session-lineage'
import { isBotBackgroundRun, type BotBackgroundRuns } from '../bot-background-run-records'

export type BotChatEndTarget = {
  /** The id `orca bot chats` lists it by. */
  root: string
  /** The session running it now, which an end closes. */
  live: string
  /** Every Orca session of the lineage, the live one included. */
  lineage: string[]
  title: string | null
}

export type BotChatEndTargetLookup =
  | { kind: 'found'; target: BotChatEndTarget }
  | { kind: 'refused'; refusal: BotChatEndRefusal }
  | { kind: 'already-ended'; target: BotChatEndTarget }

export type BotChatEndTargetSources = {
  host: Pick<StructuredAgentSessionHost, 'deps'>
  bots: readonly Bot[]
  backgroundRuns: BotBackgroundRuns
  /** The outside thread (Slack, Linear, GitHub, Discord) one of these sessions is linked to. */
  linkSource: (sessionIds: readonly string[]) => string | null
}

const notFound = { kind: 'refused', refusal: { kind: 'not-found' } } as const

/** The chat behind `id` among `bot`'s, judged as it stands now; synchronous, so a check can repeat it. */
export function lookUpBotChatEndTarget(
  sources: BotChatEndTargetSources,
  bot: Bot,
  chatId: string
): BotChatEndTargetLookup {
  const id = chatId.replace(/^chat:/, '')
  const records = readAgentSessionRecordStore()
  const record = records?.getRecord(id)
  if (!records || !record || !isOrcaSessionId(id) || isBotGroupMemberSession(id)) {
    return notFound
  }
  const owner = botOfHomeWorkspace(sources.bots, record.location.workspaceId)
  if (!owner) {
    return notFound
  }
  if (owner.id !== bot.id) {
    return { kind: 'refused', refusal: { kind: 'other-bot' } }
  }
  const rootOf = createCanonicalOrcaSessionResolver(records)
  const root = rootOf(id)
  const running = resolveLineageRunningSession(records, root)
  const rootRecord = records.getRecord(root)
  if (running.kind !== 'here' || !rootRecord) {
    return notFound
  }
  const lineage = running.lineage.filter(isOrcaSessionId)
  if (
    lineage.some(isBotGroupMemberSession) ||
    isBotBackgroundRun(sources.backgroundRuns, rootRecord)
  ) {
    return notFound
  }
  const home =
    bot.chatSessionId && isOrcaSessionId(bot.chatSessionId) ? rootOf(bot.chatSessionId) : null
  if (home === root) {
    return { kind: 'refused', refusal: { kind: 'home' } }
  }
  const target = {
    root,
    live: running.record.sessionId,
    lineage,
    title: rootRecord.conversationName ?? null
  }
  const store = sources.host.deps.store
  if (
    store.isSessionEnded(target.live) ||
    (!store.isSessionTabVisible(target.live) && !store.isSessionInBackground(target.live))
  ) {
    return { kind: 'already-ended', target }
  }
  const linked = sources.linkSource(lineage)
  if (linked) {
    return { kind: 'refused', refusal: { kind: 'linked', source: linked } }
  }
  return { kind: 'found', target }
}
