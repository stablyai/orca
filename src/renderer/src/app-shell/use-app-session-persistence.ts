import { useEffect } from 'react'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '../store'
import { isDirectSshRemoteWorkspaceApplyInProgress } from '../hooks/remote-workspace-snapshot-apply'
import { createSessionWriteSubscriber } from '../lib/session-write-subscriber'
import { buildActiveViewUnloadPatch } from '../lib/active-view-persist'
import {
  isIntentionalAppRestartInProgress,
  registerUpdaterBeforeUnloadBypass
} from '../lib/updater-beforeunload'
import {
  buildWorkspaceSessionPayload,
  shouldPersistWorkspaceSession
} from '../lib/workspace-session'
import {
  buildWorkspaceSessionHostSnapshots,
  patchWorkspaceSessionByHost
} from '../lib/workspace-session-host-persistence'
import {
  createShutdownCheckpointBeforeUnloadHandler,
  createShutdownCheckpointGuard
} from '../lib/shutdown-checkpoint-guard'
import { shutdownBufferCaptures } from '../components/terminal-pane/shutdown-buffer-captures'
import { dispatchWindowCloseRequest } from '../components/window-close-request-coordinator'
import {
  ORCA_APP_RESTART_ABORTED_EVENT,
  ORCA_UPDATER_QUIT_AND_INSTALL_ABORTED_EVENT
} from '../../../shared/updater-renderer-events'
import { ORCA_RENDERER_UNLOAD_PREVENTED_EVENT } from '../../../shared/renderer-shutdown-events'
import type { RemoteWorkspacePatchResult } from '../../../shared/remote-workspace-types'

// Why: bound the resume-record loss window on a hard kill to ~1 min; capture skips unchanged records so per-tick cost is negligible.
const SLEEPING_AGENT_RESUME_CAPTURE_INTERVAL_MS = 60_000

function applyRemoteWorkspacePatchStatus(
  targetId: string,
  result: RemoteWorkspacePatchResult
): void {
  const store = useAppStore.getState()
  if (result.ok) {
    store.setRemoteWorkspaceSyncStatus(targetId, {
      phase: 'synced',
      direction: 'push',
      revision: result.snapshot.revision,
      updatedAt: result.snapshot.updatedAt,
      lastSyncedAt: Date.now(),
      message: translate('auto.App.332dbfa497', 'Workspace uploaded')
    })
    return
  }
  store.setRemoteWorkspaceSyncStatus(targetId, {
    phase: result.reason === 'stale-revision' ? 'conflict' : 'offline',
    direction: 'push',
    revision: result.snapshot?.revision,
    updatedAt: result.snapshot?.updatedAt,
    lastSyncedAt: Date.now(),
    message:
      result.message ??
      (result.reason === 'stale-revision'
        ? translate(
            'auto.hooks.useIpcEvents.workspaceChangedOnAnotherDevice',
            'Workspace changed on another device'
          )
        : translate('auto.hooks.useIpcEvents.2fe88c2e06', 'Remote workspace sync unavailable'))
  })
}

/**
 * Writes durable renderer session state to disk: the debounced per-host writer, the remote
 * workspace upload chain, and the synchronous shutdown checkpoint.
 */
export function useAppSessionPersistence(): void {
  useEffect(() => registerUpdaterBeforeUnloadBypass(), [])

  // Why: session persistence only writes to disk; a Zustand subscribe() outside React drops ~15 render-cycle subscriptions and their re-renders on every tab/file/browser change.
  useEffect(() => {
    return createSessionWriteSubscriber({
      store: useAppStore,
      shouldSchedulePersist: () => !isDirectSshRemoteWorkspaceApplyInProgress(),
      persist: ({ patch }) => {
        const state = useAppStore.getState()
        // Why: route each host's worktree-scoped slice to its own partition; return the local write so the remote-workspace upload chain below keeps its ordering.
        const localWrite = patchWorkspaceSessionByHost(window.api.session, patch, state)
        void localWrite
        const hydratedTargetIds = Array.from(state.remoteWorkspaceHydratedTargetIds).filter(
          (targetId) => state.remoteWorkspaceSyncStatusByTargetId[targetId]?.phase !== 'conflict'
        )
        if (hydratedTargetIds.length > 0) {
          void localWrite
            .then(() => window.api.remoteWorkspace?.setForConnectedTargets({ hydratedTargetIds }))
            .then((results) => {
              for (const { targetId, result } of results ?? []) {
                applyRemoteWorkspacePatchStatus(targetId, result)
              }
            })
            .catch((err) => {
              for (const targetId of hydratedTargetIds) {
                useAppStore.getState().setRemoteWorkspaceSyncStatus(targetId, {
                  phase: 'error',
                  direction: 'push',
                  message: err instanceof Error ? err.message : 'Workspace upload failed'
                })
              }
            })
        }
      }
    })
  }, [])

  // On shutdown, capture terminal scrollback buffers and flush all durable
  // renderer state through one synchronous main-process checkpoint.
  useEffect(() => {
    // Why: beforeunload fires twice during a manual quit — once from the
    // synthetic dispatch in the onWindowCloseRequested handler (captures
    // good data while TerminalPanes are still mounted), and again from the
    // native window close triggered by confirmWindowClose(). Between these
    // two firings, PTY exit events can arrive and unmount TerminalPanes,
    // emptying shutdownBufferCaptures. The guard prevents the second call
    // from overwriting the good session data with an empty snapshot.
    const shutdownCheckpoint = createShutdownCheckpointGuard(() => {
      const shouldCaptureSession = shouldPersistWorkspaceSession(useAppStore.getState())
      if (shouldCaptureSession) {
        for (const capture of shutdownBufferCaptures.values()) {
          try {
            capture({ includeLocalBuffers: false })
          } catch {
            // Don't let one pane's failure block the rest.
          }
        }
        // Why: agent provider session ids live only in agentStatusByPaneKey,
        // which is in-memory. Capture them into the persisted sleeping-session
        // map so a daemon/session death while the app is closed can still
        // cold-restore via the agent's resume command (#5232).
        useAppStore.getState().captureAllSleepingAgentSessions('quit')
      }
      // Why: re-read state after capture() calls populated scrollback buffers
      // into the store via Zustand setters. The earlier read is only for the
      // gating flags and would miss those updates.
      const freshState = useAppStore.getState()
      let sessionSnapshots: ReturnType<typeof buildWorkspaceSessionHostSnapshots> = []
      try {
        sessionSnapshots = shouldCaptureSession
          ? buildWorkspaceSessionHostSnapshots(buildWorkspaceSessionPayload(freshState), freshState)
          : []
      } catch (error) {
        // Why: dirty drafts exist only in the full session snapshot.
        if (
          !isIntentionalAppRestartInProgress() ||
          freshState.openFiles.some((file) => file.isDirty)
        ) {
          throw error
        }
        console.error('[app] Full renderer session snapshot failed; using durable session', error)
        window.api.app.stageBeforeUnloadSync({
          sessions: [],
          ui: buildActiveViewUnloadPatch(freshState)
        })
        return
      }
      window.api.app.stageBeforeUnloadSync({
        sessions: sessionSnapshots,
        ui: buildActiveViewUnloadPatch(freshState)
      })
    })
    const persistBeforeUnload = createShutdownCheckpointBeforeUnloadHandler(shutdownCheckpoint)
    window.addEventListener('beforeunload', persistBeforeUnload)
    window.addEventListener(ORCA_APP_RESTART_ABORTED_EVENT, shutdownCheckpoint.reset)
    window.addEventListener(ORCA_UPDATER_QUIT_AND_INSTALL_ABORTED_EVENT, shutdownCheckpoint.reset)
    window.addEventListener(ORCA_RENDERER_UNLOAD_PREVENTED_EVENT, shutdownCheckpoint.reset)
    return () => {
      window.removeEventListener('beforeunload', persistBeforeUnload)
      window.removeEventListener(ORCA_APP_RESTART_ABORTED_EVENT, shutdownCheckpoint.reset)
      window.removeEventListener(
        ORCA_UPDATER_QUIT_AND_INSTALL_ABORTED_EVENT,
        shutdownCheckpoint.reset
      )
      window.removeEventListener(ORCA_RENDERER_UNLOAD_PREVENTED_EVENT, shutdownCheckpoint.reset)
    }
  }, [])

  // Why: beforeunload never fires on a hard kill (crash, forced update, TerminateProcess), so periodically capture agent session ids (not scrollback) so live agents keep a resume record.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!shouldPersistWorkspaceSession(useAppStore.getState())) {
        return
      }
      useAppStore.getState().captureAllSleepingAgentSessions('periodic')
    }, SLEEPING_AGENT_RESUME_CAPTURE_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [])

  // Why: subscribe at the always-mounted App root — Terminal owns the confirm flow but isn't mounted on the landing page, so subscribing there left File→Exit / Ctrl+Q with no listener (#5144).
  useEffect(() => {
    return window.api.ui.onWindowCloseRequested(dispatchWindowCloseRequest)
  }, [])

  // Why no periodic scrollback save: the old 3-min re-serialize (#461) stalled the main thread for seconds; the out-of-process daemon (#729) is the durable replacement, non-daemon users lose in-session scrollback on unexpected exit.
}
