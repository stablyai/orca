import { useCallback, useEffect, useMemo } from 'react'
import {
  nativeChatComposerCatalog,
  type NativeChatStructuredCatalogInputs
} from '../../../src/shared/native-chat-composer-catalog'
import {
  applyAutocomplete,
  detectAutocompleteTrigger,
  rankSuggestions
} from './mobile-native-chat-autocomplete'
import { getMobileNativeChatCommands } from './mobile-native-chat-send-classification'
import {
  mobileNativeChatSlashMenu,
  type MobileNativeChatSlashMenu
} from './mobile-native-chat-slash-menu'
import {
  composerSuggestionInsertText,
  type ComposerSuggestion,
  type ComposerSuggestionSection
} from './MobileNativeChatComposerSuggestions'

const NO_SECTIONS: readonly ComposerSuggestionSection[] = []

/** Desktop's grouping: a heading per non-empty group, only when the menu is grouped. */
function slashMenuSections(menu: MobileNativeChatSlashMenu): ComposerSuggestionSection[] {
  const groups = [
    { key: 'commands', title: 'Commands', items: menu.commands },
    { key: 'skills', title: 'Skills', items: menu.skills }
  ]
  return groups
    .filter((group) => group.items.length > 0)
    .map((group) => ({
      key: group.key,
      title: menu.grouped ? group.title : null,
      data: group.items.map((item) => ({ kind: 'picker' as const, item }))
    }))
}

function fileSuggestionSections(paths: readonly string[]): ComposerSuggestionSection[] {
  return paths.length > 0
    ? [{ key: 'files', title: null, data: paths.map((path) => ({ kind: 'file', path })) }]
    : []
}

/** The composer's `/` and `@` suggestions and how a pick edits the draft. */
export function useMobileNativeChatComposerAutocomplete(args: {
  value: string
  cursor: number
  agent: string | null | undefined
  /** Defined exactly on the structured lane, even before the host answers. */
  slashCatalog: NativeChatStructuredCatalogInputs | undefined
  filePaths: readonly string[]
  onNeedFiles: ((query: string) => void) | undefined
  onChangeText: (text: string) => void
  moveCaret: (cursor: number) => void
}): {
  sections: readonly ComposerSuggestionSection[]
  pick: (suggestion: ComposerSuggestion) => void
} {
  const { value, cursor, agent, slashCatalog, filePaths } = args
  const { onNeedFiles, onChangeText, moveCaret } = args
  const trigger = useMemo(() => detectAutocompleteTrigger(value, cursor), [value, cursor])
  const triggerKind = trigger?.kind
  const query = trigger?.query ?? ''
  const structured = slashCatalog !== undefined
  const sessionCommands = slashCatalog?.sessionCommands
  const conversationCommands = slashCatalog?.conversationCommands
  // Why: keyed on the catalog's own references, so typing re-ranks without re-selecting.
  const catalog = useMemo(
    () =>
      agent
        ? nativeChatComposerCatalog(
            agent,
            // Why: drops rows only desktop answers (e.g. /context); the phone can't show the reply.
            getMobileNativeChatCommands(agent),
            structured ? { sessionCommands, conversationCommands } : undefined
          )
        : null,
    [agent, conversationCommands, sessionCommands, structured]
  )
  // Why: keyed on the trigger's primitives and stable catalog references only, so
  // streamed frames that re-render the composer never rebuild the rows.
  const sections = useMemo(() => {
    if (triggerKind === 'slash') {
      return slashMenuSections(mobileNativeChatSlashMenu({ agent, catalog, query }))
    }
    if (triggerKind === 'file') {
      return fileSuggestionSections(rankSuggestions(filePaths, query))
    }
    return NO_SECTIONS
  }, [agent, catalog, filePaths, query, triggerKind])

  useEffect(() => {
    if (triggerKind === 'file') {
      onNeedFiles?.(query)
    }
  }, [onNeedFiles, query, triggerKind])

  const pick = useCallback(
    (suggestion: ComposerSuggestion) => {
      if (!trigger) {
        return
      }
      const next = applyAutocomplete(value, trigger, composerSuggestionInsertText(suggestion))
      onChangeText(next.text)
      moveCaret(next.cursor)
    },
    [moveCaret, onChangeText, trigger, value]
  )
  return { sections, pick }
}
