import { useEffect, useRef } from 'react'
import { isCursorAgentTitle } from '../../../src/shared/agent-title-core'
import type { MobileSessionTab } from './mobile-session-route-types'
import type { MobileDesktopTabTitle } from './mobile-desktop-tab-titles'
import {
  getMobileSessionTabTitle,
  resolveMobileTerminalTabAgentId,
  resolveMobileTerminalTabOwnedAgentId
} from './mobile-terminal-tab-agent'

type TabTitle = {
  terminal: string | null
  cursor: boolean
  desktop: boolean
  title: string
}

/**
 * Display names for the session tab strip. Cursor CLI alternates its task title with a generic
 * `Cursor Agent` / `Cursor ready` frame, so a Cursor tab keeps its last task name (or the
 * desktop's saved name) through those frames instead of flickering between the two.
 */
export function useMobileSessionTabTitles(
  tabs: readonly MobileSessionTab[],
  scope: string,
  desktopTabTitles?: ReadonlyMap<string, MobileDesktopTabTitle>
): ReadonlyMap<string, string> {
  const committed = useRef<{ scope: string; titles: Map<string, TabTitle> } | null>(null)
  const previous = committed.current?.scope === scope ? committed.current.titles : undefined
  const next = new Map<string, TabTitle>()
  const labels = new Map<string, string>()
  for (const tab of tabs) {
    let title = getMobileSessionTabTitle(tab)
    if (tab.type === 'terminal') {
      const candidate = tab.terminal ? desktopTabTitles?.get(tab.terminal) : undefined
      const desktop =
        candidate?.tabId === (tab.parentTabId ?? tab.id) &&
        (!tab.leafId || candidate.leafId === tab.leafId)
          ? candidate
          : undefined
      const old = previous?.get(tab.id)
      const retained = old?.terminal === tab.terminal && old?.cursor ? old : undefined
      const ownedAgent = resolveMobileTerminalTabOwnedAgentId(tab)
      const titleAgent = resolveMobileTerminalTabAgentId(tab)
      const cursor =
        titleAgent === 'cursor' ||
        (!ownedAgent && desktop?.agentIdentity === 'cursor') ||
        (!ownedAgent && !titleAgent && !!retained)
      const savedTitle = cursor && !isCursorAgentTitle(desktop?.title) ? desktop?.title : undefined
      if (cursor) {
        // Why: saved desktop names survive the first generic OSC frame and screen remounts.
        title = savedTitle
          ? savedTitle
          : isCursorAgentTitle(tab.title)
            ? ((desktop && retained?.desktop ? undefined : retained?.title) ?? 'Cursor Agent')
            : getMobileSessionTabTitle({ ...tab, launchAgent: 'cursor' })
      }
      next.set(tab.id, { terminal: tab.terminal, cursor, desktop: !!savedTitle, title })
    }
    labels.set(tab.id, title)
  }
  // Why: a discarded render must not feed the next title, and closed tabs drop out here.
  useEffect(() => {
    committed.current = { scope, titles: next }
  })
  return labels
}
