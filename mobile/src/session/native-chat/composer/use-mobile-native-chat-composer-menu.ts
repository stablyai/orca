import { prepareQueuedMessageEditText } from '../../../../../src/shared/queued-message-edit-command'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  applyMentionSuggestion,
  applyPickerSuggestion,
  deriveComposerAutocomplete,
  isSkillPickerTriggered
} from '../../../../../src/shared/native-chat-composer-autocomplete'
import type { NativeChatSkillDiscoverySnapshot } from '../../../../../src/shared/native-chat/input/native-chat-picker-items'
import {
  boundedMenuItems,
  draftAfterSkillEdit,
  narrowedMenuItems,
  leadingSkillToken,
  MENU_ROWS_PER_GROUP,
  mobileComposerCatalog,
  mobileComposerSkillTokens,
  type MobileComposerStructuredCatalog
} from './mobile-native-chat-composer-menu'
import type { ComposerMenuRow } from './MobileNativeChatComposerMenu'

type Selection = { start: number; end: number }
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
  onNeedFiles?: (query: string) => void
  skillDiscovery?: NativeChatSkillDiscoverySnapshot
  onNeedSkills?: () => void
  /** The `/` menu opened; the session's list may have changed since it was read. */
  onSlashMenuOpen?: () => void
  /** A picked skill; a send carries its file while its token stays, and treats a leading one as chat. */
  onPickSkill?: (skill: { token: string; path?: string }) => void
  editing?: boolean
  refuseCommand?: (text: string) => boolean
  focusField: () => void
}) {
  const { value, onChangeText, agent, structuredCatalog, filePaths, skillDiscovery } = input
  const [cursor, setCursor] = useState(0)
  // Drives the caret only right after an insert; a permanently controlled `selection` breaks
  // manual caret placement in React Native.
  const [pendingSelection, setPendingSelection] = useState<Selection | null>(null)
  const [menuKind, setMenuKind] = useState<MenuKind | null>(null)

  const reported = structuredCatalog?.reported
  const acceptsText = useMemo(
    () => prepareQueuedMessageEditText(agent ?? 'codex', reported),
    [agent, reported]
  )
  const commandAvailable = useMemo(
    () => (input.editing ? (name: string) => acceptsText(`/${name}`) : undefined),
    [input.editing, acceptsText]
  )
  const catalog = useMemo(
    () =>
      mobileComposerCatalog({ agent, structured: structuredCatalog, discovery: skillDiscovery }),
    [agent, skillDiscovery, structuredCatalog]
  )
  const skillTokens = useMemo(() => mobileComposerSkillTokens(catalog), [catalog])
  const skillToken = leadingSkillToken(value, skillTokens)
  const setDraft = (next: string): void => {
    if (!next.startsWith('/')) {
      setMenuKind(null)
    }
    onChangeText(next)
  }
  const onFieldChange = (next: string): void => {
    const draft = skillToken ? draftAfterSkillEdit(value, next, skillToken) : next
    setDraft(draft)
    if (draft !== next) {
      placeCaret(0)
    }
  }

  // Triggers read only the text before the caret, so edits after it rebuild nothing.
  const beforeCaret = value.slice(0, cursor)
  const autocomplete = useMemo(
    () =>
      deriveComposerAutocomplete(
        beforeCaret,
        beforeCaret.length,
        catalog.commands,
        catalog.discovery.skills,
        catalog.profile,
        catalog.discovery,
        null,
        catalog.sessionSkills,
        commandAvailable
      ),
    [beforeCaret, catalog, commandAvailable]
  )
  const rows = useMemo<ComposerMenuRow[]>(() => {
    if (autocomplete.mode === 'mention') {
      return filePaths.slice(0, MENU_ROWS_PER_GROUP).map((path) => ({
        kind: 'file' as const,
        id: `file:${path}`,
        path
      }))
    }
    if (autocomplete.mode !== 'slash') {
      return []
    }
    return narrowedMenuItems(boundedMenuItems(autocomplete.items), menuKind)
  }, [autocomplete, filePaths, menuKind])

  const { onNeedFiles, onNeedSkills, onSlashMenuOpen } = input
  // Scan disk skills only once a token needs them, as desktop does.
  const skillsTriggered = isSkillPickerTriggered(beforeCaret, catalog.profile)
  useEffect(() => {
    if (skillsTriggered) {
      onNeedSkills?.()
    }
  }, [onNeedSkills, skillsTriggered])
  const mentionQuery = autocomplete.mode === 'mention' ? autocomplete.query : null
  useEffect(() => {
    if (mentionQuery !== null) {
      onNeedFiles?.(mentionQuery)
    }
  }, [onNeedFiles, mentionQuery])
  const slashOpen = autocomplete.mode === 'slash'
  useEffect(() => {
    if (slashOpen) {
      onSlashMenuOpen?.()
    }
  }, [onSlashMenuOpen, slashOpen])

  const placeCaret = useCallback((at: number): void => {
    setCursor(at)
    setPendingSelection({ start: at, end: at })
  }, [])

  const pick = (row: ComposerMenuRow): void => {
    if (autocomplete.mode === 'none') {
      return
    }
    if (row.kind === 'command' && input.refuseCommand?.(row.token)) {
      return
    }
    setMenuKind(null)
    // Restore page field focus after a menu tap so typing continues at the inserted pick.
    input.focusField()
    if (row.kind === 'file') {
      const next = applyMentionSuggestion(value, cursor, row.path)
      setDraft(next.draft)
      placeCaret(next.caret)
      return
    }
    const next = applyPickerSuggestion(value, cursor, row)
    // A skill at the start becomes the leading chip; mid-prompt it stays plain text like desktop.
    const leadingSkill =
      row.kind === 'skill' && next.insertedToken && next.caret === row.token.length + 1
    setDraft(leadingSkill ? `${row.token} ${value.slice(cursor).trimStart()}` : next.draft)
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
    skillToken,
    skillCount: skillTokens.size,
    rows,
    pick,
    openSlashMenu,
    openFileMenu,
    pendingSelection,
    placeCaret,
    onSelectionChange: (selection: Selection): void => {
      setCursor(selection.end)
      setPendingSelection(null)
    },
    resetCursor: () => setCursor(0)
  }
}
