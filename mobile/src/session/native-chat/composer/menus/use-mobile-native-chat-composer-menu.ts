import { useEffect, useMemo, useState } from 'react'
import {
  applyMentionSuggestion,
  deriveComposerAutocomplete,
  isSkillPickerTriggered
} from '../../../../../../src/shared/native-chat/input/composer/native-chat-composer-autocomplete'
import { applyPickerSuggestion } from '../../../../../../src/shared/native-chat/input/composer/native-chat-picker-triggers'
import {
  structuredAgentSessionModePickDraft,
  structuredAgentSessionPickEntersGoalMode
} from '../../../../../../src/shared/agent-session/view/structured-agent-session-goal-mode'
import {
  agentSessionInteractionCommand,
  type AgentSessionInteractionMode
} from '../../../../../../src/shared/agent-session/options/permissions/agent-session-interaction-mode'
import type { NativeChatSkillDiscoverySnapshot } from '../../../../../../src/shared/native-chat/input/composer/native-chat-picker-items'
import {
  boundedMenuItems,
  draftAfterSkillEdit,
  narrowedMenuItems,
  leadingSkillToken,
  MENU_ROWS_PER_GROUP,
  mobileComposerSkillTokens,
  type MobileComposerStructuredCatalog
} from './mobile-native-chat-composer-menu'
import {
  isMentionBotRow,
  type ComposerMenuRow,
  type ComposerRoomMention
} from './MobileNativeChatComposerMenu'
import type { SlashCommandSuggestion } from '../../../../../../src/shared/native-chat/input/commands/native-chat-slash-commands'
import { rankNativeChatRoomMembers } from '../../../../../../src/shared/native-chat/input/native-chat-room-mentions'
import { useBotMentionField } from './mobile-native-chat-bot-mention-display'
import { useMobileNativeChatMentionBotMenu } from './use-mobile-native-chat-mention-bot-menu'
import type { MentionBots } from './use-mobile-native-chat-mention-bots'
import { useMobileNativeChatComposerCatalog } from './use-mobile-native-chat-composer-catalog'

const NO_COMMANDS: readonly SlashCommandSuggestion[] = []
/** Opening the menu from the + sheet narrows it to what that row named. */
type MenuKind = 'skill' | 'command'

// Keep a picked skill’s leading token atomic in both draft text and field rendering.
export function useMobileNativeChatComposerMenu(input: {
  value: string
  onChangeText: (text: string) => void
  agent: string | null
  /** Undefined on a terminal-backed chat. */
  structuredCatalog: MobileComposerStructuredCatalog | undefined
  filePaths: readonly string[]
  /** Set in a room: `@` lists these members instead of files. */
  roomMentions?: readonly ComposerRoomMention[]
  /** Outside a room, `@` lists the chat's host's bots above the files. */
  mentionBots?: MentionBots
  onNeedFiles?: (query: string) => void
  /** How a picked file is written when the chat runs in a workspace sub-folder. */
  fileReference?: (path: string) => string | undefined
  skillDiscovery?: NativeChatSkillDiscoverySnapshot
  onNeedSkills?: () => void
  /** The `/` menu opened; the session's list may have changed since it was read. */
  onSlashMenuOpen?: () => void
  onSlashMenuDemand?: (open: boolean) => void
  /** A picked skill; a send carries its file while its token stays, and treats a leading one as chat. */
  onPickSkill?: (skill: Extract<ComposerMenuRow, { kind: 'skill' }>) => void
  /** An Orca command row was picked; it outranks an earlier skill pick of the same token. */
  onPickOrcaCommand?: (token: string) => void
  editing?: boolean
  interactionModeSupported?: boolean
  admitsInteractionMode?: (mode: AgentSessionInteractionMode) => boolean
  onPickInteractionMode?: (mode: AgentSessionInteractionMode) => void
  refuseCommand?: (text: string) => boolean
  /** `/` lists skills only: the text goes somewhere no chat command acts on. */
  skillsOnly?: boolean
  /** Picking `/goal` enters goal mode instead of inserting the command; an edit has no goal mode. */
  goalMode?: { hostSetsGoals: boolean; enter?: () => void }
  focusField: () => void
}) {
  const { value, onChangeText, agent, structuredCatalog, filePaths, roomMentions, skillDiscovery } =
    input
  const field = useBotMentionField(value)
  const { cursor, place: placeCaret } = field
  const [menuKind, setMenuKind] = useState<MenuKind | null>(null)

  const { catalog, commandAvailable } = useMobileNativeChatComposerCatalog({
    agent,
    structuredCatalog,
    skillDiscovery,
    editing: input.editing,
    interactionModeSupported: input.interactionModeSupported,
    hostSetsGoals: input.goalMode?.hostSetsGoals
  })
  const skillTokens = useMemo(() => mobileComposerSkillTokens(catalog), [catalog])
  const skillToken = leadingSkillToken(value, skillTokens)
  const setDraft = (next: string): void => {
    if (!next.startsWith('/')) {
      setMenuKind(null)
    }
    onChangeText(next)
  }
  const onFieldChange = (shown: string): void => {
    const edit = field.edit(shown)
    const draft = skillToken ? draftAfterSkillEdit(value, edit.draft, skillToken) : edit.draft
    setDraft(draft)
    const caret = draft !== edit.draft ? 0 : edit.caret
    if (caret !== null) {
      placeCaret(caret)
    }
  }

  const botMenu = useMobileNativeChatMentionBotMenu(input.mentionBots)
  // Triggers read only the text before the caret, so edits after it rebuild nothing.
  const beforeCaret = value.slice(0, cursor)
  const autocomplete = useMemo(
    () =>
      deriveComposerAutocomplete(
        beforeCaret,
        beforeCaret.length,
        input.skillsOnly ? NO_COMMANDS : catalog.commands,
        catalog.discovery.skills,
        catalog.profile,
        catalog.discovery,
        null,
        catalog.sessionSkills,
        commandAvailable,
        botMenu.nameMatches
      ),
    [beforeCaret, catalog, commandAvailable, input.skillsOnly, botMenu.nameMatches]
  )
  const mention = autocomplete.mode === 'mention' ? autocomplete : null
  botMenu.follow(mention)
  const rows = useMemo<ComposerMenuRow[]>(() => {
    if (autocomplete.mode === 'mention' && roomMentions) {
      const members = new Map(roomMentions.map((mention) => [mention.name, mention]))
      return rankNativeChatRoomMembers([...members.values()], autocomplete.query)
        .matches.slice(0, MENU_ROWS_PER_GROUP)
        .map(({ name }) => ({
          kind: 'member' as const,
          id: `member:${name}`,
          name,
          icon: members.get(name)?.icon
        }))
    }
    if (autocomplete.mode === 'mention') {
      return botMenu.listed(autocomplete, filePaths)
    }
    if (autocomplete.mode !== 'slash') {
      return []
    }
    return narrowedMenuItems(boundedMenuItems(autocomplete.items), menuKind)
  }, [autocomplete, filePaths, menuKind, roomMentions, botMenu.listed])

  const { onNeedFiles, onNeedSkills, onSlashMenuOpen } = input
  // Scan disk skills only once a token needs them, as desktop does.
  const skillsTriggered = isSkillPickerTriggered(beforeCaret, catalog.profile)
  // A restored draft's leading skill was never typed here, yet its chip needs the catalog too.
  const leadingSkillTriggered = isSkillPickerTriggered(
    value.split(' ', 1)[0] ?? '',
    catalog.profile
  )
  // Each caret trigger still re-asks, so reopening the menu retries a failed scan.
  useEffect(() => {
    if (skillsTriggered || leadingSkillTriggered) {
      onNeedSkills?.()
    }
  }, [onNeedSkills, skillsTriggered, leadingSkillTriggered])
  const openedBots = input.mentionBots?.opened
  const botsOpen = mention !== null && !roomMentions
  useEffect(() => openedBots?.(botsOpen), [openedBots, botsOpen])
  const mentionQuery = mention && !roomMentions ? botMenu.fileQuery(mention) : null
  useEffect(() => {
    if (mentionQuery !== null) {
      onNeedFiles?.(mentionQuery)
    }
  }, [onNeedFiles, mentionQuery])
  const { onSlashMenuDemand } = input
  const slashOpen = autocomplete.mode === 'slash'
  useEffect(() => {
    if (slashOpen) {
      onSlashMenuOpen?.()
    }
  }, [onSlashMenuOpen, slashOpen])

  useEffect(() => {
    onSlashMenuDemand?.(slashOpen)
    return () => onSlashMenuDemand?.(false)
  }, [onSlashMenuDemand, slashOpen])

  const pick = (row: ComposerMenuRow): void => {
    if (autocomplete.mode === 'none') {
      return
    }
    if (row.kind === 'command' && input.refuseCommand?.(row.token)) {
      return
    }
    if (row.kind === 'command' && row.orcaOwned) {
      input.onPickOrcaCommand?.(row.token)
    }
    const enterGoalMode = input.goalMode?.enter
    const changeMode = input.onPickInteractionMode
    const mode =
      !input.editing &&
      structuredCatalog &&
      input.interactionModeSupported &&
      row.kind === 'command' &&
      row.orcaOwned
        ? agentSessionInteractionCommand(agent ?? '', row.token)
        : null
    const modeDraft =
      mode !== null && row.kind === 'command'
        ? structuredAgentSessionModePickDraft(value, cursor, row)
        : null
    if (mode !== null && (!modeDraft || !changeMode || !input.admitsInteractionMode?.(mode))) {
      input.focusField()
      return
    }
    setMenuKind(null)
    // Restore page field focus after a menu tap so typing continues at the inserted pick.
    input.focusField()
    if (isMentionBotRow(row)) {
      const botToken = botMenu.pick(row, mention)
      if (botToken !== null) {
        const next = applyMentionSuggestion(value, cursor, '', botToken, botMenu.nameMatches)
        setDraft(next.draft)
        placeCaret(next.caret)
      }
      return
    }
    if (row.kind === 'file' || row.kind === 'member') {
      const next =
        row.kind === 'file'
          ? applyMentionSuggestion(value, cursor, row.path, input.fileReference?.(row.path))
          : applyMentionSuggestion(value, cursor, row.name, `@${row.name}`)
      setDraft(next.draft)
      placeCaret(next.caret)
      return
    }
    if (
      mode !== null ||
      (enterGoalMode &&
        structuredAgentSessionPickEntersGoalMode(row, input.goalMode?.hostSetsGoals === true))
    ) {
      const next = modeDraft ?? structuredAgentSessionModePickDraft(value, cursor, row)
      if (!next) {
        return
      }
      if (mode !== null) {
        changeMode?.(mode)
      }
      setDraft(next.draft)
      placeCaret(next.caret)
      if (mode === null) {
        enterGoalMode?.()
      }
      return
    }
    const next = applyPickerSuggestion(value, cursor, row)
    // A skill at the start becomes the leading chip; mid-prompt it stays plain text like desktop.
    const leadingSkill =
      row.kind === 'skill' && next.insertedToken && next.caret === row.token.length + 1
    setDraft(leadingSkill ? `${row.token} ${next.draft.slice(next.caret).trimStart()}` : next.draft)
    if (row.kind === 'skill') {
      input.onPickSkill?.(row)
    }
    placeCaret(next.caret)
  }

  const openSlashMenu = (kind: MenuKind): void => {
    const rest = (skillToken ? value.slice(skillToken.length + 1) : value).trimStart()
    onChangeText(rest ? `/ ${rest}` : '/')
    setMenuKind(kind)
    placeCaret(1)
    input.focusField()
  }

  const openFileMenu = (): void => {
    const before = value.slice(0, cursor)
    const lead = before.length === 0 || /\s$/.test(before) ? '@' : ' @'
    setDraft(before + lead + value.slice(cursor))
    placeCaret(before.length + lead.length)
    input.focusField()
  }

  return {
    onFieldChange,
    /** This chat's own commands, which the + sheet reads for /compact and /goal. */
    commands: catalog.commands,
    skillToken,
    skillCount: skillTokens.size,
    rows,
    pick,
    openSlashMenu,
    openFileMenu,
    openBotChats: (row: Extract<ComposerMenuRow, { kind: 'bot' }>) => {
      botMenu.openChats(row, mention)
      input.focusField()
    },
    display: field.display,
    pendingSelection: field.pendingSelection,
    dictationAnchor: field.anchor,
    placeCaret,
    onSelectionChange: field.onSelectionChange,
    resetCursor: field.resetCursor
  }
}
