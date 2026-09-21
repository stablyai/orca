import type { LegacyPaneKeyAliasEntry } from '../../../shared/persisted-state-types'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { isTerminalLeafId, makePaneKey } from '../../../shared/stable-pane-id'
import { agentHookServer } from '../../agent-hooks/server'
import { collectLayoutLeafIdsInOrder, firstLayoutLeafId } from './terminal-layout-normalization'

export function findWorktreeIdForTab(
  session: WorkspaceSessionState,
  tabId: string
): string | undefined {
  for (const [worktreeId, tabs] of Object.entries(session.tabsByWorktree ?? {})) {
    if (tabs.some((tab) => tab.id === tabId)) {
      return worktreeId
    }
  }
  return undefined
}

export type TerminalTabLookup = {
  get(tabId: string): TerminalTab | undefined
}

/** Resolves tabs on demand while retaining first-match ordering and scan progress. */
export function createLazyTerminalTabLookup(session: WorkspaceSessionState): TerminalTabLookup {
  const tabsByWorktree = Object.entries(session.tabsByWorktree ?? {})
  const tabsById = new Map<string, TerminalTab>()
  let worktreeIndex = 0
  let tabIndex = 0
  let exhausted = false

  return {
    get(requestedTabId: string): TerminalTab | undefined {
      if (tabsById.has(requestedTabId)) {
        return tabsById.get(requestedTabId)
      }
      if (exhausted) {
        return undefined
      }

      while (worktreeIndex < tabsByWorktree.length) {
        const tabs = tabsByWorktree[worktreeIndex][1]
        while (tabIndex < tabs.length) {
          const currentIndex = tabIndex
          tabIndex += 1
          // Array#some, used by the prior lookup, skips sparse holes.
          if (!(currentIndex in tabs)) {
            continue
          }
          const tab = tabs[currentIndex]
          const tabId = tab.id
          // Preserve first-match behavior when persisted IDs collide.
          if (!tabsById.has(tabId)) {
            tabsById.set(tabId, tab)
          }
          if (tabId === requestedTabId) {
            return tabsById.get(requestedTabId)
          }
        }
        worktreeIndex += 1
        tabIndex = 0
      }

      exhausted = true
      return undefined
    }
  }
}

/** Bridges a tab's legacy numeric pane keys to stable ones; returns the alias rows worth persisting. */
export function registerLegacyPaneKeyAliasesForTab(args: {
  tabId: string
  tab: TerminalTab | undefined
  inputLayout: TerminalLayoutSnapshot
  normalizedLayout: TerminalLayoutSnapshot
  leafIdByInputLeafId: Map<string, string>
}): LegacyPaneKeyAliasEntry[] {
  const legacyPaneKeyAliasEntries: LegacyPaneKeyAliasEntry[] = []
  const registeredLegacyPaneKeys = new Set<string>()
  const hasLeafPtyBindings = Object.keys(args.inputLayout.ptyIdsByLeafId ?? {}).length > 0
  const fallbackPtyId =
    !hasLeafPtyBindings && typeof args.tab?.ptyId === 'string' ? args.tab.ptyId : undefined
  const registerLegacyAlias = (inputLeafId: string, leafId: string, ptyId?: string): boolean => {
    if (!isTerminalLeafId(leafId)) {
      return false
    }
    let paneKey: string
    try {
      paneKey = makePaneKey(args.tabId, leafId)
    } catch {
      return false
    }
    const numeric = /^(?:pane:)?(\d+)$/.exec(inputLeafId)?.[1]
    if (!numeric) {
      return false
    }
    // Why: PaneManager ids are 1-based; a zero-based alias in split layouts makes tab:1 ambiguous and misroutes panes.
    const legacyPaneKey = `${args.tabId}:${numeric}`
    agentHookServer.registerPaneKeyAlias(legacyPaneKey, paneKey, ptyId)
    registeredLegacyPaneKeys.add(legacyPaneKey)
    if (ptyId) {
      legacyPaneKeyAliasEntries.push({
        ptyId,
        legacyPaneKey,
        stablePaneKey: paneKey,
        updatedAt: Date.now()
      })
      return true
    }
    return false
  }
  const inputLeafIds = new Set([
    ...collectLayoutLeafIdsInOrder(args.inputLayout.root),
    ...Object.keys(args.inputLayout.ptyIdsByLeafId ?? {})
  ])
  for (const inputLeafId of inputLeafIds) {
    if (isTerminalLeafId(inputLeafId)) {
      continue
    }
    const leafId = args.leafIdByInputLeafId.get(inputLeafId)
    if (leafId) {
      registerLegacyAlias(
        inputLeafId,
        leafId,
        args.inputLayout.ptyIdsByLeafId?.[inputLeafId] ?? fallbackPtyId
      )
    }
  }
  if (args.tab?.ptyId && !hasLeafPtyBindings) {
    const fallbackLeafId =
      args.normalizedLayout.activeLeafId ?? firstLayoutLeafId(args.normalizedLayout.root)
    let paneKey: string | undefined
    if (fallbackLeafId && isTerminalLeafId(fallbackLeafId)) {
      try {
        paneKey = makePaneKey(args.tabId, fallbackLeafId)
      } catch {
        // Why: a persisted tabId can be malformed; skip the alias instead of aborting the whole load-time normalization.
      }
    }
    if (paneKey) {
      for (const legacyPaneKey of [`${args.tabId}:0`, `${args.tabId}:1`]) {
        if (registeredLegacyPaneKeys.has(legacyPaneKey)) {
          continue
        }
        agentHookServer.registerPaneKeyAlias(legacyPaneKey, paneKey, args.tab.ptyId)
        legacyPaneKeyAliasEntries.push({
          ptyId: args.tab.ptyId,
          legacyPaneKey,
          stablePaneKey: paneKey,
          updatedAt: Date.now()
        })
      }
    }
  }
  return legacyPaneKeyAliasEntries
}
