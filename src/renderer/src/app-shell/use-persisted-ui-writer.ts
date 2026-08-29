import { useEffect } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../store'
import {
  capturePersistedUIWriteBaseline,
  diffPersistedUIWriteFields,
  persistedUIWriteFieldsToWireUpdate,
  type PersistedUIWriteBaseline
} from '../store/slices/persisted-ui-write-baseline'

/**
 * Send one field patch and settle it against the baseline. Fields are marked
 * in flight so a hydration during the round-trip can't revert a newer local
 * flip-back; on ack the patch folds into the baseline (generation-guarded: a
 * hydration during the round trip wins instead) and a debounced trailing
 * flush re-diffs the mirror — an edit made while the write was in flight,
 * which diffed empty against the pre-fold baseline, is re-sent then. A
 * rejected write folds nothing, leaving its fields dirty to re-flush on the
 * next change (no automatic retry loop) — which is why this sends through
 * setWithAck: the web preload's plain set swallows transport failures.
 */
function sendPersistedUIWrite(changed: Partial<PersistedUIWriteBaseline>): void {
  const fields = Object.keys(changed) as (keyof PersistedUIWriteBaseline)[]
  const state = useAppStore.getState()
  const sentAtGeneration = state.persistedUIWriteBaselineGeneration
  state.notePersistedUIWriteStarted(fields)
  let request: Promise<void>
  try {
    // setWithAck rejects when the host did not apply the patch (web's plain set
    // swallows transport failures); older preloads without it fall back to set.
    const send = window.api.ui.setWithAck ?? window.api.ui.set
    request = send(persistedUIWriteFieldsToWireUpdate(changed))
  } catch {
    // A synchronous throw (e.g. a non-cloneable value) must still settle the
    // in-flight marker, or the field stays pinned against hydration forever.
    useAppStore.getState().notePersistedUIWriteSettled(fields, null)
    scheduleTrailingPersistedUIFlush()
    return
  }
  // Two-arg then: the rejection handler must not catch throws from the ack
  // handler, which would double-settle these fields and leak the trailing ones.
  request.then(
    () => {
      useAppStore.getState().notePersistedUIWriteSettled(fields, changed, { sentAtGeneration })
      scheduleTrailingPersistedUIFlush()
    },
    () => {
      useAppStore.getState().notePersistedUIWriteSettled(fields, null)
      // A trailing pass skipped because THIS write was in flight must still
      // happen — a rejection schedules nothing on its own, and a pending
      // flip-back would otherwise be stranded until the next edit.
      scheduleTrailingPersistedUIFlush()
    }
  )
}

/**
 * Debounced (never inline at ack rate — one in-flight write must not turn a
 * drag into one ui.set per IPC round trip) re-diff of the mirror against the
 * settled baseline. Skips while any write is still in flight: that write's
 * own ack schedules the next pass, so overlapping timers can't double-send.
 * Termination invariant: each acked write folds exactly the values it diffed
 * (or a hydration advances the baseline), so the trailing diff shrinks to
 * empty; without the fold this would loop.
 */
function scheduleTrailingPersistedUIFlush(): void {
  window.setTimeout(() => {
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
      sendPersistedUIWrite(trailing)
    }
  }, 150)
}

/**
 * Mirrors the sidebar/right-sidebar/filter preferences into the durable UI file.
 *
 * Why field-level diffs (STA-5781): the durable UI state is shared with mobile/web
 * clients, which edit it concurrently. Writing the whole snapshot let this client's
 * stale mirror overwrite fields another client had just changed. The writer now
 * diffs the mirror against the last state hydrated from main and persists only the
 * fields this client changed itself; main merges partial updates field-by-field.
 *
 * Why (#9002): activeView is deliberately kept off this debounced writer. It used to ride the
 * same 150ms save (#8265), so every top-level view switch scheduled a full durable-state write.
 */
export function usePersistedUIWriter(): void {
  const persistedUIReady = useAppStore((s) => s.persistedUIReady)
  const activeView = useAppStore((s) => s.activeView)
  const ui = useAppStore(
    useShallow(
      (s): PersistedUIWriteBaseline => ({
        sidebarWidth: s.sidebarWidth,
        rightSidebarOpen: s.rightSidebarOpen,
        rightSidebarTab: s.rightSidebarTab,
        rightSidebarExplorerView: s.rightSidebarExplorerView,
        rightSidebarWidth: s.rightSidebarWidth,
        markdownTocPanelWidth: s.markdownTocPanelWidth,
        combinedDiffFileTreeWidth: s.combinedDiffFileTreeWidth,
        groupBy: s.groupBy,
        sortBy: s.sortBy,
        projectOrderBy: s.projectOrderBy,
        showSleepingWorkspaces: s.showSleepingWorkspaces,
        hideDefaultBranchWorkspace: s.hideDefaultBranchWorkspace,
        hideAutomationGeneratedWorkspaces: s.hideAutomationGeneratedWorkspaces,
        hideCliCreatedWorkspaces: s.hideCliCreatedWorkspaces,
        hideDetachedHeadWorkspaces: s.hideDetachedHeadWorkspaces,
        hideWorkspacesFromOtherDevices: s.hideWorkspacesFromOtherDevices,
        alwaysShowDefaultBranchWorkspace: s.alwaysShowDefaultBranchWorkspace,
        showDotfilesByWorktree: s.showDotfilesByWorktree,
        filterRepoIds: s.filterRepoIds,
        // Why: dashboard auto-acks (fire on focus/visibility) and the in-memory ack cleanup
        // paths in agent-status.ts (close/dismiss) flow to disk through map identity changes.
        // Without persisting, agent rows that survive restart come back bold even when the
        // user had already visited them.
        acknowledgedAgentsByPaneKey: s.acknowledgedAgentsByPaneKey
      })
    )
  )
  useEffect(() => {
    // The baseline holds the values this client last saw persisted (newest
    // hydration from main, overlaid with this client's flushed writes); fields
    // equal to it are never written, so remote changes are never echoed back.
    // Read via getState, not a selector: baseline identity changes on every
    // broadcast, and subscribing would re-render and re-arm the debounce on
    // remote traffic that changed nothing this writer owns.
    const armBaseline = useAppStore.getState().persistedUIWriteBaseline
    if (!persistedUIReady || !armBaseline) {
      return
    }
    if (Object.keys(diffPersistedUIWriteFields(ui, armBaseline)).length === 0) {
      return
    }
    const timer = window.setTimeout(() => {
      // Re-diff against the store at fire time: a broadcast landing inside the
      // debounce window may have refreshed the baseline (its identity is
      // deliberately NOT an effect dep, so remote traffic can't starve the timer).
      const state = useAppStore.getState()
      const baseline = state.persistedUIWriteBaseline
      if (!baseline) {
        return
      }
      const changed = diffPersistedUIWriteFields(ui, baseline)
      if (Object.keys(changed).length === 0) {
        return
      }
      sendPersistedUIWrite(changed)
    }, 150)

    return () => window.clearTimeout(timer)
  }, [persistedUIReady, ui])

  // Why (#9002): activeView has its own tiny profile preference, so it can track
  // every switch without scheduling the multi-MB durable-state writer.
  useEffect(() => {
    if (!persistedUIReady) {
      return
    }
    void window.api.ui.set({ activeView })
  }, [activeView, persistedUIReady])
}
