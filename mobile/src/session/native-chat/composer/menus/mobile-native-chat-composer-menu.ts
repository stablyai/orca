import type { AgentSessionConversationCommand } from '../../../../../../src/shared/agent-session/conversation-context/agent-session-conversation-command'
import type { AgentSessionSlashCommand } from '../../../../../../src/shared/agent-session/agent-session-wire'
import {
  getAgentAnsweredNativeChatCommands,
  getNativeChatAgentProfile,
  type NativeChatAgentProfile
} from '../../../../../../src/shared/native-chat/input/commands/native-chat-agent-profiles'
import { nativeChatPickerScannedSkills } from '../../../../../../src/shared/native-chat/input/composer/native-chat-composer-autocomplete'
import {
  buildNativeChatPickerItems,
  type NativeChatPickerItem,
  type NativeChatSkillDiscoverySnapshot
} from '../../../../../../src/shared/native-chat/input/composer/native-chat-picker-items'
import {
  nativeChatPickerCommands,
  nativeChatSessionSkills
} from '../../../../../../src/shared/native-chat/input/commands/native-chat-skill-visibility'
import type {
  NativeChatSessionSkill,
  SlashCommandSuggestion
} from '../../../../../../src/shared/native-chat/input/commands/native-chat-slash-commands'
import { structuredSessionSlashCommands } from '../../../../../../src/shared/agent-session/view/structured-agent-session-slash-menu'
import {
  NATIVE_CHAT_RESUME_COMMAND,
  withNativeChatOrcaCommands
} from '../../../../../../src/shared/native-chat/input/commands/native-chat-orca-commands'
import {
  isNativeChatSideChatCommand,
  withNativeChatSideChatCommands
} from '../../../../../../src/shared/native-chat/input/commands/native-chat-side-chat-command'
import { translate } from '../../../../i18n/mobile-i18n'

// Why: the menu is a plain ScrollView right above a streaming transcript, so it mounts a bounded
// number of rows; typing narrows the rest.
export const MENU_ROWS_PER_GROUP = 10

export type MobileComposerStructuredCatalog = {
  /** What the session reported for its `/` menu; undefined until read or on an older host. */
  reported: readonly AgentSessionSlashCommand[] | undefined
  conversationCommands: readonly AgentSessionConversationCommand[]
  compactInstructions?: boolean
  /** `/mcp` opens the chat's MCP tray. */
  mcpPanel?: boolean
  /** `/fork` forks the chat, and `/side` and `/btw` are Orca's, as on desktop. */
  fork?: boolean
  /** `/usage` opens the chat's Codex account usage. */
  accountUsage?: boolean
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
  discovery = NO_DISCOVERY,
  interactionModeSupported = false
}: {
  agent: string | null
  structured: MobileComposerStructuredCatalog | undefined
  discovery?: NativeChatSkillDiscoverySnapshot
  interactionModeSupported?: boolean
}): MobileComposerCatalog {
  if (!agent) {
    return { profile: null, commands: [], discovery: NO_DISCOVERY, sessionSkills: [] }
  }
  const reported = structured?.reported
  const commands = structured
    ? withMobileOrcaCommands(
        structuredSessionSlashCommands(
          agent,
          structured.conversationCommands,
          reported,
          structured.compactInstructions,
          interactionModeSupported,
          structured.mcpPanel
        ),
        structured
      )
    : getAgentAnsweredNativeChatCommands(agent)
  return {
    profile: getNativeChatAgentProfile(agent),
    commands: nativeChatPickerCommands(agent, commands, discovery.skills),
    discovery,
    sessionSkills: nativeChatSessionSkills(agent, reported)
  }
}

/** Desktop's Orca rows: `/fork` and `/usage` run here; `/resume`, `/side` and `/btw` say they are desktop-only. */
function withMobileOrcaCommands(
  commands: readonly SlashCommandSuggestion[],
  structured: MobileComposerStructuredCatalog
): SlashCommandSuggestion[] {
  const desktopOnly = mobileDesktopOnlyCommandNotice()
  const rows = withNativeChatOrcaCommands(commands, {
    resume: desktopOnly,
    ...(structured.accountUsage
      ? {
          usage: translate(
            'components.native-chat.usage.description',
            'Show usage for this chat’s Codex account'
          )
        }
      : {}),
    ...(structured.fork
      ? {
          fork: translate(
            'components.native-chat.fork.commandDescription',
            'Fork this chat from its latest response'
          )
        }
      : {})
  })
  if (!structured.fork) {
    return rows
  }
  const sideRows = withNativeChatSideChatCommands(rows, {
    side: desktopOnly,
    btw: desktopOnly,
    argumentHint: '',
    unavailableReason: desktopOnly
  })
  // Desktop puts its working rows first; rows that only explain themselves go last here.
  const own = sideRows.filter((row) => row.orcaOwned && isNativeChatSideChatCommand(row.name))
  return [...sideRows.filter((row) => !own.includes(row)), ...own]
}

export function mobileDesktopOnlyCommandNotice(): string {
  return translate('session.orcaCommands.desktopOnly', 'Available in the desktop app')
}

/** Orca commands the phone lists but leaves to the desktop app, never sending them as text. */
export function isMobileDesktopOnlyCommand(
  name: string,
  structured: MobileComposerStructuredCatalog | undefined
): boolean {
  return (
    structured !== undefined &&
    (name === NATIVE_CHAT_RESUME_COMMAND ||
      (structured.fork === true && isNativeChatSideChatCommand(name)))
  )
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
