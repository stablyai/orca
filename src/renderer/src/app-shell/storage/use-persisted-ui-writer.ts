import { useEffect, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../../store/index'
import { isWebClientLocation } from '../platform/web-client-location'
import {
  writeWebChatReadMarkEdits,
  type WebChatReadMarks
} from '@/web/preload-api/preferences/web-chat-read-mark-storage'
import { adoptChatReadMarkAliases } from '@/store/slices/agent-status/structured-sessions/chat-read-mark-aliases'
import type { WebUiApi } from '@/web/preload-api/preferences/web-ui-api'
import {
  capturePersistedUIWriteBaseline,
  diffPersistedUIWriteFields,
  PERSISTED_UI_WRITE_BASELINE_FIELDS,
  persistedUIWriteFieldsToWireUpdate,
  type PersistedUIWriteBaseline
} from '../../store/slices/ui/persisted-ui-write-baseline'

/** Protect in-flight fields from hydration reverting local flip-backs. Fold acknowledged patches only into the same baseline generation, then debounce a fresh diff for edits made during flight.
 * Rejected writes remain dirty until a new edit; never auto-retry a terminal failure. setWithAck exposes failures swallowed by web’s plain set. */
type PersistedUIWriteController = {
  activate: () => void
  send: (changed: Partial<PersistedUIWriteBaseline>) => void
  scheduleTrailing: () => void
  dispose: () => void
}

function createPersistedUIWriteController(): PersistedUIWriteController {
  let disposed = false
  let trailingTimer: number | null = null

  const scheduleTrailing = (): void => {
    if (disposed) {
      return
    }
    if (trailingTimer !== null) {
      window.clearTimeout(trailingTimer)
    }
    trailingTimer = window.setTimeout(() => {
      trailingTimer = null
      if (disposed) {
        return
      }
      const state = useAppStore.getState()
      if (Object.keys(state.persistedUIWriteInFlightCounts).length > 0) {
        return
      }
      const baseline = state.persistedUIWriteBaseline
      if (!baseline) {
        return
      }
      const trailing = diffPersistedUIWriteFields(capturePersistedUIWriteBaseline(state), baseline)
      if (Object.keys(trailing).length > 0) {
        controller.send(trailing)
      }
    }, 150)
  }

  const send = (changed: Partial<PersistedUIWriteBaseline>): void => {
    if (disposed) {
      return
    }
    const state = useAppStore.getState()
    const baseline = state.persistedUIWriteBaseline
    let marks: Partial<WebChatReadMarks> | undefined
    if (isWebClientLocation()) {
      const {
        activityClearedAtByPaneKey,
        manuallyUnreadTurnsByPaneKey,
        ...hostAndOtherLocalChanges
      } = changed
      if (activityClearedAtByPaneKey || manuallyUnreadTurnsByPaneKey) {
        marks = {
          ...(activityClearedAtByPaneKey && { activityClearedAtByPaneKey }),
          ...(manuallyUnreadTurnsByPaneKey && { manuallyUnreadTurnsByPaneKey })
        }
      }
      changed = hostAndOtherLocalChanges
    }
    const fields = PERSISTED_UI_WRITE_BASELINE_FIELDS.filter((field) =>
      Object.hasOwn(changed, field)
    )
    if (fields.length === 0) {
      if (baseline && marks) {
        try {
          const persisted = writeWebChatReadMarkEdits(marks, baseline)
          useAppStore.setState({
            ...persisted,
            persistedUIWriteBaseline: { ...baseline, ...persisted }
          })
        } catch {
          // Leave local marks dirty when storage rejects the write.
        }
      }
      return
    }
    const sentAtGeneration = state.persistedUIWriteBaselineGeneration
    state.notePersistedUIWriteStarted(fields)
    let request: Promise<void>
    try {
      const updates = persistedUIWriteFieldsToWireUpdate(changed)
      if (baseline && marks) {
        const ui: Window['api']['ui'] & {
          setPersistedUIWithAck?: WebUiApi['setPersistedUIWithAck']
        } = window.api.ui
        const setPersistedUIWithAck = ui.setPersistedUIWithAck
        if (typeof setPersistedUIWithAck !== 'function') {
          throw new TypeError('Web UI persistence is unavailable')
        }
        const persisted = setPersistedUIWithAck.call(ui, updates, marks, baseline)
        request = persisted.request
        useAppStore.setState({
          ...persisted.marks,
          persistedUIWriteBaseline: { ...baseline, ...persisted.marks }
        })
      } else {
        const send = window.api.ui.setWithAck ?? window.api.ui.set
        request = send(updates)
      }
    } catch {
      // Settle even synchronous failure so fields cannot stay pinned against hydration forever.
      useAppStore.getState().notePersistedUIWriteSettled(fields, null)
      return
    }
    // Use two-argument then so an ack-handler throw cannot trigger double settlement in the rejection branch.
    request.then(
      () => {
        const latest = useAppStore.getState()
        if (latest.persistedUIWriteBaselineGeneration === sentAtGeneration) {
          adoptChatReadMarkAliases(changed)
        }
        latest.notePersistedUIWriteSettled(fields, changed, { sentAtGeneration })
        scheduleTrailing()
      },
      () => {
        useAppStore.getState().notePersistedUIWriteSettled(fields, null)
        // Flush newer pending edits, not the rejected patch itself; terminal failures must not loop.
        const state = useAppStore.getState()
        const baseline = state.persistedUIWriteBaseline
        const dirty = baseline
          ? diffPersistedUIWriteFields(capturePersistedUIWriteBaseline(state), baseline)
          : {}
        const current = capturePersistedUIWriteBaseline(state)
        const changedDuringFlight = fields.some(
          (field) => !Object.is(current[field], changed[field])
        )
        const shouldRetry =
          changedDuringFlight ||
          PERSISTED_UI_WRITE_BASELINE_FIELDS.some(
            (field) => Object.hasOwn(dirty, field) && !fields.includes(field)
          )
        if (shouldRetry) {
          scheduleTrailing()
        }
      }
    )
  }

  const controller: PersistedUIWriteController = {
    activate: () => {
      disposed = false
    },
    send,
    scheduleTrailing,
    dispose: () => {
      disposed = true
      if (trailingTimer !== null) {
        window.clearTimeout(trailingTimer)
        trailingTimer = null
      }
    }
  }
  return controller
}

/** Diff against hydrated/acknowledged state so concurrent mobile/web writes cannot be overwritten by stale sibling fields (STA-5781). Main merges partial updates.
 * Keep activeView off this debounce; its tiny separate preference avoids full durable writes per navigation (#9002). */
export function usePersistedUIWriter(): void {
  const controller = useMemo(() => createPersistedUIWriteController(), [])
  const persistedUIReady = useAppStore((s) => s.persistedUIReady)
  const activeView = useAppStore((s) => s.activeView)
  const ui = useAppStore(
    useShallow((s): PersistedUIWriteBaseline => ({
      gitGraphFiltersByWorktree: s.gitGraphFiltersByWorktree,
      sidebarWidth: s.sidebarWidth,
      sidebarOpen: s.sidebarOpen,
      rightSidebarOpen: s.rightSidebarOpen,
      rightSidebarTab: s.rightSidebarTab,
      rightSidebarExplorerView: s.rightSidebarExplorerView,
      rightSidebarWidth: s.rightSidebarWidth,
      activityBarPosition: s.activityBarPosition,
      activityBarOrder: s.activityBarOrder,
      activityBarBotOrder: s.activityBarBotOrder,
      activityBarHidden: s.activityBarHidden,
      markdownTocPanelWidth: s.markdownTocPanelWidth,
      combinedDiffFileTreeWidth: s.combinedDiffFileTreeWidth,
      groupBy: s.groupBy,
      sortBy: s.sortBy,
      projectOrderBy: s.projectOrderBy,
      showSleepingWorkspaces: s.showSleepingWorkspaces,
      workspaceHostScope: s.workspaceHostScope,
      visibleWorkspaceHostIds: s.visibleWorkspaceHostIds,
      hideDefaultBranchWorkspace: s.hideDefaultBranchWorkspace,
      hideAutomationGeneratedWorkspaces: s.hideAutomationGeneratedWorkspaces,
      hideCliCreatedWorkspaces: s.hideCliCreatedWorkspaces,
      hideDetachedHeadWorkspaces: s.hideDetachedHeadWorkspaces,
      hideWorkspacesFromOtherDevices: s.hideWorkspacesFromOtherDevices,
      alwaysShowDefaultBranchWorkspace: s.alwaysShowDefaultBranchWorkspace,
      explorerDisplayRootByWorktree: s.explorerDisplayRootByWorktree,
      showDotfilesByWorktree: s.showDotfilesByWorktree,
      notificationsMutedByWorktree: s.notificationsMutedByWorktree,
      filterRepoIds: s.filterRepoIds,
      // Persist focus/visibility acknowledgements and close/dismiss cleanup by map identity so live history keeps its read state after restart.
      acknowledgedAgentsByPaneKey: s.acknowledgedAgentsByPaneKey,
      // Retain Clear completed across restart.
      activityClearedAtByPaneKey: s.activityClearedAtByPaneKey,
      // Retain explicit mark-unread across restart.
      manuallyUnreadTurnsByPaneKey: s.manuallyUnreadTurnsByPaneKey
    }))
  )
  useEffect(() => {
    controller.activate()
    return () => controller.dispose()
  }, [controller])
  useEffect(() => {
    // Diff against last hydration plus flushed writes; never echo unchanged remote fields. Read baseline via getState so broadcasts cannot rerender/rearm this debounce.
    const armBaseline = useAppStore.getState().persistedUIWriteBaseline
    if (!persistedUIReady || !armBaseline) {
      return
    }
    if (Object.keys(diffPersistedUIWriteFields(ui, armBaseline)).length === 0) {
      return
    }
    const timer = window.setTimeout(() => {
      // Rediff at fire time for intervening broadcasts; baseline is not an effect dependency so remote traffic cannot starve the timer.
      const state = useAppStore.getState()
      const baseline = state.persistedUIWriteBaseline
      if (!baseline) {
        return
      }
      const changed = diffPersistedUIWriteFields(capturePersistedUIWriteBaseline(state), baseline)
      if (Object.keys(changed).length === 0) {
        return
      }
      controller.send(changed)
    }, 150)

    return () => window.clearTimeout(timer)
  }, [controller, persistedUIReady, ui])

  // activeView uses a tiny profile preference rather than the multi-MB durable writer (#9002).
  useEffect(() => {
    if (!persistedUIReady) {
      return
    }
    void window.api.ui.set({ activeView })
  }, [activeView, persistedUIReady])
}
