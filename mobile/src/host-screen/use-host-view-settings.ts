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
import { applyCollapse, withPendingViewChanges } from './host-view-pending-changes'
import {
  useSwitchedHostPendingViewChanges,
  type PendingViewStatus
} from './use-host-pending-view-changes'
import type { FilterState } from '../worktree/workspace-list-types'

const REFUSED_NOTE = 'The desktop did not take that change.'
const NOTHING_PENDING: PendingViewStatus = { pending: [], stale: false }

export function useHostViewSettings(args: {
  client: RpcClient | null
  connState: ConnectionState
  state: HostScreenState
}) {
  const { client, connState, state } = args
  const { clientRef, setActionError, setShowPinnedInGroups, setView, viewRef } = state

  const localEditsRef = useRef(0)
  const pendingViewChanges = useSwitchedHostPendingViewChanges(client)
  const pendingChanges = pendingViewChanges?.controls ?? null

  const applyViewState = useCallback((next: MobileViewState) => {
    viewRef.current = next
    setView(next)
  }, [])

  const syncViewSettingsFromDesktop = useCallback(
    async (options: { resend?: boolean } = {}) => {
      if (!client || connState !== 'connected') {
        return
      }
      const requestClient = client
      const editsAtRequest = localEditsRef.current
      const opsAtRequest = pendingChanges?.lastOpId() ?? 0
      try {
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
        const uiRead = uiReply ? hostViewSettingsRead.interpret(uiReply) : null
        const read = uiRead?.accepted ? uiRead.value : undefined
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Preserve the established response shape at this boundary.
        const ui = read as WorkspaceViewSettings | undefined
        // What the desktop had not answered when the read went out still shows as asked.
        const waiting =
          pendingChanges && ui
            ? pendingChanges.reconcile(ui, {
                resend: options.resend === true,
                sentByOpId: opsAtRequest
              })
            : []
        // Why skip after a local edit: this reply may predate it; the edit's own change event re-reads.
        if (localEditsRef.current !== editsAtRequest) {
          return
        }
        let next = ui
          ? withPendingViewChanges(applyDesktopViewSettings(viewRef.current, ui), waiting)
          : viewRef.current
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
    },
    [client, connState, applyViewState, pendingChanges]
  )
  // A refusal undoes the change by re-reading what the desktop holds.
  const refused = useCallback(() => {
    setActionError(REFUSED_NOTE)
    void syncViewSettingsFromDesktop()
  }, [setActionError, syncViewSettingsFromDesktop])

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
      // Patch only touched fields so a stale mirror cannot revert another client’s sibling edits (STA-5781).
      const payload: WorkspaceViewSettings = buildWorkspaceViewSettingsUpdate(patch, next, options)
      if (Object.keys(payload).length === 0) {
        return
      }
      if (pendingChanges) {
        void pendingChanges
          .sendView(patch, payload)
          .then((outcome) => outcome === 'refused' && refused())
        return
      }
      void hostViewSettingsWrite.request(client, payload).catch(() => {})
    },
    [client, applyViewState, pendingChanges, refused]
  )

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

  // Layout presets also reset shown properties; write settings first so refusal cannot leave the other layout’s preset.
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
      // One section's change, so another device's edit to a sibling section is kept.
      if (pendingChanges && client) {
        const collapsed = !viewRef.current.collapsedGroups.includes(key)
        localEditsRef.current += 1
        applyViewState(applyCollapse(viewRef.current, key, collapsed))
        void pendingChanges.sendCollapse(key, collapsed).then((outcome) => {
          if (outcome === 'unavailable') {
            persistViewSettings({ collapsedGroups: [...viewRef.current.collapsedGroups] })
          } else if (outcome === 'refused') {
            refused()
          }
        })
        return
      }
      const next = new Set(viewRef.current.collapsedGroups)
      if (!next.delete(key)) {
        next.add(key)
      }
      persistViewSettings({ collapsedGroups: [...next] })
    },
    [client, applyViewState, persistViewSettings, pendingChanges, refused]
  )
  const toggleWorktreeLineage = useCallback(
    (item: Worktree) =>
      toggleCollapsed(item.lineageGroupKey ?? getMobileWorkspaceLineageGroupKey(item)),
    [toggleCollapsed]
  )

  return {
    clearFilters,
    pendingViewChanges: pendingViewChanges?.status ?? NOTHING_PENDING,
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
