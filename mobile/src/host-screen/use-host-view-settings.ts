import { useCallback, useRef } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import { getMobileWorkspaceLineageGroupKey } from '../worktree/mobile-workspace-lineage'
import {
  applyDesktopViewSettings,
  buildWorkspaceViewSettingsUpdate,
  type MobileViewPatch,
  type MobileViewState,
  type WorkspaceViewSettings
} from '../worktree/workspace-view-settings'
import type { Worktree } from '../worktree/workspace-list-sections'
import {
  changedWorkspaceRowFilters,
  NO_WORKSPACE_ROW_FILTERS
} from '../../../src/shared/workspace-view/workspace-row-filters'
import {
  hostCardLayoutWrite,
  hostViewSettingsRead,
  hostViewSettingsWrite
} from './host-screen-operations'
import { hostListSettingsRead } from '../transport/settings-read-operations'
import type {
  AgentActivityDisplayMode,
  ProjectOrderBy,
  WorktreeCardProperty
} from '../../../src/shared/ui-chrome-types'
import { getWorktreeCardModeUpdates } from '../../../src/shared/worktree/card-properties'
import type { HostScreenState } from './use-host-screen-state'
import type { FilterState } from '../worktree/workspace-list-types'

export function useHostViewSettings(args: {
  client: RpcClient | null
  connState: ConnectionState
  state: HostScreenState
}) {
  const { client, connState, state } = args
  const { clientRef, setShowPinnedInGroups, setView, viewRef } = state

  const localEditsRef = useRef(0)

  // The one writer of the view: the ref is its synchronous mirror for edits made before a render.
  const applyViewState = useCallback((next: MobileViewState) => {
    viewRef.current = next
    setView(next)
  }, [])

  // Apply the change locally, then patch the desktop's shared store (ui.set) so both apps stay in sync.
  const persistViewSettings = useCallback(
    (patch: MobileViewPatch, options: { cardLayoutPreset?: boolean } = {}) => {
      localEditsRef.current += 1
      const previous = viewRef.current
      const next: MobileViewState = {
        ...previous,
        ...patch,
        filters: { ...previous.filters, ...patch.filters }
      }
      applyViewState(next)
      if (!client) {
        return
      }
      // Send only the touched fields: the host merges partial updates, so a stale
      // mirror can no longer revert sibling settings another client just changed
      // (STA-5781; supersedes the #8873 whole-payload special case).
      const payload: WorkspaceViewSettings = buildWorkspaceViewSettingsUpdate(patch, next, options)
      if (Object.keys(payload).length === 0) {
        return
      }
      void hostViewSettingsWrite.request(client, payload).catch(() => {
        // Best-effort: view settings are a convenience preference.
      })
    },
    [client, applyViewState]
  )

  // Merge the desktop's shared view settings (PersistedUIState) onto local state so desktop changes appear here.
  const syncViewSettingsFromDesktop = useCallback(async () => {
    if (!client || connState !== 'connected') {
      return
    }
    const requestClient = client
    const editsAtRequest = localEditsRef.current
    try {
      // Each half applies on its own, so one failing read does not hold back the other.
      const [uiReply, settingsReply] = await Promise.all([
        hostViewSettingsRead.request(requestClient).catch(() => null),
        hostListSettingsRead.request(requestClient).catch(() => null)
      ])
      // Why the client, not the host id: a new host always arrives with a new client.
      if (clientRef.current !== requestClient) {
        return
      }
      const hostSettings = settingsReply
        ? hostListSettingsRead.interpret(settingsReply)
        : { accepted: false as const }
      if (hostSettings.accepted) {
        setShowPinnedInGroups(hostSettings.value.showPinnedWorktreesInGroups)
      }
      // Why skip after a local edit: this reply may predate it; the edit's own change event re-reads.
      if (localEditsRef.current !== editsAtRequest) {
        return
      }
      const uiRead = uiReply ? hostViewSettingsRead.interpret(uiReply) : null
      const read = uiRead?.accepted ? uiRead.value : undefined
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Preserve the established response shape at this boundary.
      const ui = read as WorkspaceViewSettings | undefined
      let next = ui ? applyDesktopViewSettings(viewRef.current, ui) : viewRef.current
      if (hostSettings.accepted) {
        const { compactWorktreeCards, newCardStyle } = hostSettings.value
        next = { ...next, compactWorktreeCards, newCardStyle }
      }
      if (next !== viewRef.current) {
        applyViewState(next)
      }
    } catch {
      // Transient transport failure; retry on the next focus/connect.
    }
  }, [client, connState, applyViewState])

  const handleSortChange = useCallback(
    (value: MobileViewState['sortBy']) => {
      persistViewSettings({ sortBy: value })
    },
    [persistViewSettings]
  )

  const setFilter = useCallback(
    <Key extends keyof FilterState>(key: Key, value: FilterState[Key]) => {
      persistViewSettings({ filters: { [key]: value } })
    },
    [persistViewSettings]
  )

  const toggleRepoFilter = useCallback(
    (repoId: string) => {
      const current = viewRef.current.filters.filterRepoIds
      setFilter(
        'filterRepoIds',
        current.includes(repoId) ? current.filter((id) => id !== repoId) : [...current, repoId]
      )
    },
    [setFilter]
  )

  // Why every filter: Clear filters on the desktop resets them all, not only the ones shown here.
  const clearFilters = useCallback(() => {
    persistViewSettings({
      // Only what differs: an older host's strict ui.set refuses a key it does not know.
      filters: changedWorkspaceRowFilters(viewRef.current.filters, NO_WORKSPACE_ROW_FILTERS)
    })
  }, [persistViewSettings])

  const handleGroupChange = useCallback(
    (value: MobileViewState['groupBy']) => {
      persistViewSettings({ groupBy: value })
    },
    [persistViewSettings]
  )

  const setProjectOrderBy = useCallback(
    (value: ProjectOrderBy) => persistViewSettings({ projectOrderBy: value }),
    [persistViewSettings]
  )

  const setAgentActivityDisplayMode = useCallback(
    (value: AgentActivityDisplayMode) => persistViewSettings({ agentActivityDisplayMode: value }),
    [persistViewSettings]
  )

  const toggleCardProperty = useCallback(
    (property: WorktreeCardProperty) => {
      const current = viewRef.current.worktreeCardProperties
      persistViewSettings({
        worktreeCardProperties: current.includes(property)
          ? current.filter((candidate) => candidate !== property)
          : [...current, property]
      })
    },
    [persistViewSettings]
  )

  // Why both halves: a layout is a preset, so the desktop also resets the shown properties.
  // Why the setting first: a host that refuses it must not be left with the other layout's preset.
  const setCardLayout = useCallback(
    (layout: 'detailed' | 'compact') => {
      if (!client) {
        return
      }
      const updates = getWorktreeCardModeUpdates(layout === 'compact' ? 'Compact' : 'Default')
      void (async () => {
        try {
          const reply = await hostCardLayoutWrite.request(client, updates.settings)
          if (!hostCardLayoutWrite.interpret(reply).accepted || clientRef.current !== client) {
            return
          }
        } catch {
          return
        }
        persistViewSettings(
          {
            worktreeCardProperties: updates.ui.worktreeCardProperties,
            compactWorktreeCards: updates.settings.compactWorktreeCards
          },
          { cardLayoutPreset: true }
        )
      })()
    },
    [client, persistViewSettings]
  )

  const toggleCollapsed = useCallback(
    (key: string) => {
      const next = new Set(viewRef.current.collapsedGroups)
      if (!next.delete(key)) {
        next.add(key)
      }
      persistViewSettings({ collapsedGroups: [...next] })
    },
    [persistViewSettings]
  )
  const toggleWorktreeLineage = useCallback(
    (item: Worktree) => toggleCollapsed(getMobileWorkspaceLineageGroupKey(item)),
    [toggleCollapsed]
  )

  return {
    clearFilters,
    setAgentActivityDisplayMode,
    setCardLayout,
    setProjectOrderBy,
    toggleCardProperty,
    handleGroupChange,
    handleSortChange,
    syncViewSettingsFromDesktop,
    toggleCollapsed,
    setFilter,
    toggleRepoFilter,
    toggleWorktreeLineage
  }
}

export type HostViewSettings = ReturnType<typeof useHostViewSettings>
