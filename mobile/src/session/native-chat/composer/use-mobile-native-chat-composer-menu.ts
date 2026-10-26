import { useEffect, useMemo, useState } from 'react'
import {
  applyAutocomplete,
  detectAutocompleteTrigger,
  rankSuggestions
} from './mobile-native-chat-autocomplete'
import {
  draftAfterSkillEdit,
  narrowedMenuItems,
  leadingSkillToken,
  mobileComposerSkillTokens,
  mobileComposerSlashItems,
  type MobileComposerStructuredCatalog
} from './mobile-native-chat-composer-menu'
import { composerMenuInsertText, type ComposerMenuRow } from './MobileNativeChatComposerMenu'

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
  /** The `/` menu opened; the session's list may have changed since it was read. */
  onSlashMenuOpen?: () => void
  focusField: () => void
}) {
  const { value, onChangeText, agent, structuredCatalog, filePaths } = input
  const [cursor, setCursor] = useState(0)
  // Drives the caret only right after an insert; a permanently controlled `selection` breaks
  // manual caret placement in React Native.
  const [pendingSelection, setPendingSelection] = useState<Selection | null>(null)
  const [menuKind, setMenuKind] = useState<MenuKind | null>(null)

  const skillTokens = useMemo(
    () => mobileComposerSkillTokens({ agent, structured: structuredCatalog }),
    [agent, structuredCatalog]
  )
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

  const trigger = useMemo(() => detectAutocompleteTrigger(value, cursor), [value, cursor])
  // Memoize by query content so caret movement within it rebuilds nothing.
  const menuMode = trigger?.kind ?? null
  const menuQuery = trigger?.query ?? ''
  const rows = useMemo<ComposerMenuRow[]>(() => {
    if (menuMode === 'file') {
      return rankSuggestions(filePaths, menuQuery).map((path) => ({
        kind: 'file' as const,
        id: `file:${path}`,
        path
      }))
    }
    if (menuMode !== 'slash') {
      return []
    }
    const items = mobileComposerSlashItems({
      agent,
      structured: structuredCatalog,
      query: menuQuery
    })
    return narrowedMenuItems(items, menuKind)
  }, [agent, filePaths, menuKind, menuMode, menuQuery, structuredCatalog])

  const { onNeedFiles, onSlashMenuOpen } = input
  useEffect(() => {
    if (trigger?.kind === 'file') {
      onNeedFiles?.(trigger.query)
    }
  }, [onNeedFiles, trigger?.kind, trigger?.query])
  const slashOpen = trigger?.kind === 'slash'
  useEffect(() => {
    if (slashOpen) {
      onSlashMenuOpen?.()
    }
  }, [onSlashMenuOpen, slashOpen])

  const placeCaret = (at: number): void => {
    setCursor(at)
    setPendingSelection({ start: at, end: at })
  }

  const pick = (row: ComposerMenuRow): void => {
    if (!trigger) {
      return
    }
    setMenuKind(null)
    // Restore page field focus after a menu tap so typing continues at the inserted pick.
    input.focusField()
    if (row.kind === 'skill') {
      const rest = value.slice(trigger.end).trimStart()
      onChangeText(`${row.token} ${rest}`)
      placeCaret(row.token.length + 1)
      return
    }
    const next = applyAutocomplete(value, trigger, composerMenuInsertText(row))
    setDraft(next.text)
    placeCaret(next.cursor)
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
    onSelectionChange: (selection: Selection): void => {
      setCursor(selection.end)
      setPendingSelection(null)
    },
    resetCursor: () => setCursor(0)
  }
}
