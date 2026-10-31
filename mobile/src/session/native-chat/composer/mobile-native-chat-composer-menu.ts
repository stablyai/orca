import type { AgentSessionConversationCommand } from '../../../../../src/shared/agent-session/agent-session-conversation-command'
import type { AgentSessionSlashCommand } from '../../../../../src/shared/agent-session-wire'
import {
  getNativeChatAgentProfile,
  type NativeChatAgentProfile
} from '../../../../../src/shared/native-chat-agent-profiles'
import { nativeChatPickerScannedSkills } from '../../../../../src/shared/native-chat-composer-autocomplete'
import {
  buildNativeChatPickerItems,
  type NativeChatPickerItem,
  type NativeChatSkillDiscoverySnapshot
} from '../../../../../src/shared/native-chat/input/native-chat-picker-items'
import {
  nativeChatPickerCommands,
  nativeChatSessionSkills
} from '../../../../../src/shared/native-chat-skill-visibility'
import type {
  NativeChatSessionSkill,
  SlashCommandSuggestion
} from '../../../../../src/shared/native-chat/input/native-chat-slash-commands'
import { structuredSessionSlashCommands } from '../../../../../src/shared/structured-agent-session-composer'
import { getMobileNativeChatCommands } from '../mobile-native-chat-send-classification'

// Why: the menu is a plain ScrollView right above a streaming transcript, so it mounts a bounded
// number of rows; typing narrows the rest.
export const MENU_ROWS_PER_GROUP = 10

export type MobileComposerStructuredCatalog = {
  /** What the session reported for its `/` menu; undefined until read or on an older host. */
  reported: readonly AgentSessionSlashCommand[] | undefined
  conversationCommands: readonly AgentSessionConversationCommand[]
}

export type MobileComposerCatalog = {
  profile: NativeChatAgentProfile | null
  commands: readonly SlashCommandSuggestion[]
  discovery: NativeChatSkillDiscoverySnapshot
  /** Undefined keeps the host disk scan, as on desktop. */
  sessionSkills: readonly NativeChatSessionSkill[] | undefined
}

const NO_DISCOVERY: NativeChatSkillDiscoverySnapshot = { status: 'ready', skills: [] }

// Structured chats use reported commands/skills; terminal-backed chats keep curated commands.
export function mobileComposerCatalog({
  agent,
  structured,
  discovery = NO_DISCOVERY
}: {
  agent: string | null
  structured: MobileComposerStructuredCatalog | undefined
  discovery?: NativeChatSkillDiscoverySnapshot
}): MobileComposerCatalog {
  if (!agent) {
    return { profile: null, commands: [], discovery: NO_DISCOVERY, sessionSkills: [] }
  }
  const reported = structured?.reported
  const commands = structured
    ? structuredSessionSlashCommands(agent, structured.conversationCommands, reported)
    : getMobileNativeChatCommands(agent)
  return {
    profile: getNativeChatAgentProfile(agent),
    commands: nativeChatPickerCommands(agent, commands, discovery.skills),
    discovery,
    sessionSkills: nativeChatSessionSkills(agent, reported)
  }
}

export function mobileComposerSkillTokens(catalog: MobileComposerCatalog): ReadonlySet<string> {
  return new Set(
    buildNativeChatPickerItems(
      catalog.commands,
      nativeChatPickerScannedSkills(catalog.profile, catalog.discovery.skills),
      '',
      catalog.profile?.skillPrefix ?? '/',
      catalog.sessionSkills,
      Infinity
    ).flatMap((item) => (item.kind === 'skill' ? [item.token] : []))
  )
}

export function boundedMenuItems(items: readonly NativeChatPickerItem[]): NativeChatPickerItem[] {
  const counts = { command: 0, skill: 0 }
  return items.filter((item) => ++counts[item.kind] <= MENU_ROWS_PER_GROUP)
}

// If narrowing leaves no rows, show all: idle chats may report skills as plain commands.
export function narrowedMenuItems(
  items: NativeChatPickerItem[],
  kind: NativeChatPickerItem['kind'] | null
): NativeChatPickerItem[] {
  const narrowed = kind ? items.filter((item) => item.kind === kind) : []
  return narrowed.length > 0 ? narrowed : items
}

export function leadingSkillToken(draft: string, skillTokens: ReadonlySet<string>): string | null {
  const space = draft.indexOf(' ')
  if (space <= 0) {
    return null
  }
  const token = draft.slice(0, space)
  return skillTokens.has(token) ? token : null
}

export function draftAfterSkillEdit(previous: string, next: string, skillToken: string): string {
  const lead = `${skillToken} `
  if (next.startsWith(lead)) {
    return next
  }
  const rest = previous.slice(lead.length)
  return next.length < previous.length && next.endsWith(rest) ? rest : next
}
