import type { AgentSessionConversationCommand } from '../../../src/shared/agent-session-conversation-command'
import type { AgentSessionSlashCommand } from '../../../src/shared/agent-session-wire'
import { getNativeChatAgentProfile } from '../../../src/shared/native-chat-agent-profiles'
import {
  buildNativeChatPickerItems,
  type NativeChatPickerItem
} from '../../../src/shared/native-chat-picker-items'
import { sessionReportedSkills } from '../../../src/shared/native-chat-slash-commands'
import { structuredSessionSlashCommands } from '../../../src/shared/structured-agent-session-composer'
import { getMobileNativeChatCommands } from './mobile-native-chat-send-classification'

// Why: the menu is a plain ScrollView right above a streaming transcript, so it mounts a bounded
// number of rows; typing narrows the rest.
const MENU_ROWS_PER_GROUP = 10

export type MobileComposerStructuredCatalog = {
  /** What the session reported for its `/` menu; undefined until read or on an older host. */
  reported: readonly AgentSessionSlashCommand[] | undefined
  conversationCommands: readonly AgentSessionConversationCommand[]
}

type SlashMenuInput = {
  agent: string | null
  structured: MobileComposerStructuredCatalog | undefined
  query: string
}

/**
 * The `/` menu, built by the same rules as desktop's. A structured chat offers the host's commands,
 * then the session's own commands and skills once it reported them; a terminal-backed chat keeps its
 * curated commands and no skills.
 */
function slashItems(
  { agent, structured, query }: SlashMenuInput,
  limit: number
): NativeChatPickerItem[] {
  if (!agent) {
    return []
  }
  const reported = structured?.reported
  const commands = structured
    ? structuredSessionSlashCommands(agent, structured.conversationCommands, reported)
    : getMobileNativeChatCommands(agent)
  return buildNativeChatPickerItems(
    commands,
    [],
    query,
    getNativeChatAgentProfile(agent)?.skillPrefix ?? '/',
    reported ? sessionReportedSkills(reported) : [],
    limit
  )
}

/** The rows the menu draws for a query: each group capped, since typing narrows the rest. */
export function mobileComposerSlashItems(input: SlashMenuInput): NativeChatPickerItem[] {
  return slashItems(input, MENU_ROWS_PER_GROUP)
}

/** Every skill the chat can invoke, as typed, by the menu's own rules but uncapped. */
export function mobileComposerSkillTokens(
  input: Omit<SlashMenuInput, 'query'>
): ReadonlySet<string> {
  return new Set(
    slashItems({ ...input, query: '' }, Infinity).flatMap((item) =>
      item.kind === 'skill' ? [item.token] : []
    )
  )
}

/** The menu narrowed to one kind, as the + sheet's Skills and Commands rows open it. A chat at rest
 *  may report its skills as plain commands, so a narrowing that leaves nothing shows everything. */
export function narrowedMenuItems(
  items: NativeChatPickerItem[],
  kind: NativeChatPickerItem['kind'] | null
): NativeChatPickerItem[] {
  const narrowed = kind ? items.filter((item) => item.kind === kind) : []
  return narrowed.length > 0 ? narrowed : items
}

/** The skill a draft leads with: a known skill token and a space. */
export function leadingSkillToken(draft: string, skillTokens: ReadonlySet<string>): string | null {
  const space = draft.indexOf(' ')
  if (space <= 0) {
    return null
  }
  const token = draft.slice(0, space)
  return skillTokens.has(token) ? token : null
}

/** An edit that cuts into the leading skill removes all of it: it is one unit, as desktop's
 *  skill pill is. Any other edit passes through as typed. */
export function draftAfterSkillEdit(previous: string, next: string, skillToken: string): string {
  const lead = `${skillToken} `
  if (next.startsWith(lead)) {
    return next
  }
  const rest = previous.slice(lead.length)
  return next.length < previous.length && next.endsWith(rest) ? rest : next
}
