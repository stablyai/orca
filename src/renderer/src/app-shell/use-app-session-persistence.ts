import { useEffect } from 'react'
import { useAppStore } from '../store'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
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
import { showShutdownCheckpointFailureToast } from '../lib/shutdown-checkpoint-failure-toast'
import { isPairedWebClientWindow } from '../lib/desktop-window-chrome'
import { createShutdownCheckpointPersist } from './shutdown-checkpoint-persist'
import { shutdownBufferCaptures } from '../components/terminal-pane/shutdown-buffer-captures'
import {
  dispatchWindowCloseRequest,
  isWindowCloseCheckpointInProgress
} from '../components/window-close-request-coordinator'
import {
  ORCA_APP_RESTART_ABORTED_EVENT,
  ORCA_UPDATER_QUIT_AND_INSTALL_ABORTED_EVENT
} from '../../../shared/updater-renderer-events'
import {
  ORCA_RENDERER_SHUTDOWN_CHECKPOINT_ABORTED_EVENT,
  ORCA_RENDERER_UNLOAD_PREVENTED_EVENT
} from '../../../shared/renderer-shutdown-events'

// Capture unchanged-skipping resume records each minute to bound hard-kill loss.
const SLEEPING_AGENT_RESUME_CAPTURE_INTERVAL_MS = 60_000

/** Persist renderer sessions through per-host debounced writes and a synchronous shutdown checkpoint. */
export function useAppSessionPersistence(): void {
  useEffect(() => registerUpdaterBeforeUnloadBypass(), [])

  // Subscribe outside React: disk persistence needs no renders on tab/file/browser changes.
  useEffect(() => {
    return createSessionWriteSubscriber({
      store: useAppStore,
      onPersistError: (error) => console.warn('[session] Session patch failed:', error),
      persist: ({ patch }) => {
        // Route each host’s workspace slice to its own partition.
        return patchWorkspaceSessionByHost(window.api.session, patch, useAppStore.getState())
          .written
      }
    })
  }, [])

  // Capture renderer-owned state into one synchronous shutdown checkpoint.
  useEffect(() => {
    // Quit can trigger synthetic and native beforeunload. Preserve the first capture before PTY exits unmount panes and empty their buffers.
    const shutdownCheckpointPersist = createShutdownCheckpointPersist({
      shouldCaptureSession: () => shouldPersistWorkspaceSession(useAppStore.getState()),
      captureTerminalBuffers: () => {
        for (const capture of shutdownBufferCaptures.values()) {
          try {
            capture({ includeLocalBuffers: false })
          } catch {
            // Don't let one pane's failure block the rest.
          }
        }
      },
      // Persist in-memory provider session IDs for cold resume after daemon death (#5232); layout-owner main captures its own panes during quit staging.
      captureSleepingAgentSessions: ORCA_LAYOUT_OWNER_IS_MAIN
        ? () => {}
        : () => useAppStore.getState().captureAllSleepingAgentSessions('quit'),
      // Reread after capture setters populate scrollback; the earlier gating snapshot lacks it.
      buildSessionSnapshots: () => {
        const freshState = useAppStore.getState()
        return buildWorkspaceSessionHostSnapshots(
          buildWorkspaceSessionPayload(freshState),
          freshState
        )
      },
      buildUiPatch: () => buildActiveViewUnloadPatch(useAppStore.getState()),
      hasDirtyOpenFiles: () => useAppStore.getState().openFiles.some((file) => file.isDirty),
      // Allow quit fallback too; SIGKILL to escape a blocked quit loses more state (#15352).
      isDegradableShutdownInProgress: () =>
        isIntentionalAppRestartInProgress() || isWindowCloseCheckpointInProgress(),
      stageBeforeUnloadSync: (args) => window.api.app.stageBeforeUnloadSync(args)
    })
    const shutdownCheckpoint = createShutdownCheckpointGuard(
      shutdownCheckpointPersist.run,
      shutdownCheckpointPersist.abandonAttempt
    )
    // Paired web: trusted unloads include tab close/navigation, and the browser's leave prompt already reports the veto.
    const persistBeforeUnload = createShutdownCheckpointBeforeUnloadHandler(
      shutdownCheckpoint,
      isPairedWebClientWindow() ? undefined : () => showShutdownCheckpointFailureToast('reload')
    )
    window.addEventListener('beforeunload', persistBeforeUnload)
    window.addEventListener(
      ORCA_RENDERER_SHUTDOWN_CHECKPOINT_ABORTED_EVENT,
      shutdownCheckpoint.abortAfterCheckpointFailure
    )
    window.addEventListener(ORCA_APP_RESTART_ABORTED_EVENT, shutdownCheckpoint.abandonAttempt)
    window.addEventListener(
      ORCA_UPDATER_QUIT_AND_INSTALL_ABORTED_EVENT,
      shutdownCheckpoint.abandonAttempt
    )
    window.addEventListener(ORCA_RENDERER_UNLOAD_PREVENTED_EVENT, shutdownCheckpoint.abandonAttempt)
    return () => {
      window.removeEventListener('beforeunload', persistBeforeUnload)
      window.removeEventListener(
        ORCA_RENDERER_SHUTDOWN_CHECKPOINT_ABORTED_EVENT,
        shutdownCheckpoint.abortAfterCheckpointFailure
      )
      window.removeEventListener(ORCA_APP_RESTART_ABORTED_EVENT, shutdownCheckpoint.abandonAttempt)
      window.removeEventListener(
        ORCA_UPDATER_QUIT_AND_INSTALL_ABORTED_EVENT,
        shutdownCheckpoint.abandonAttempt
      )
      window.removeEventListener(
        ORCA_RENDERER_UNLOAD_PREVENTED_EVENT,
        shutdownCheckpoint.abandonAttempt
      )
    }
  }, [])

  // Hard kills skip beforeunload; periodically retain agent resume IDs, without expensive scrollback capture.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!shouldPersistWorkspaceSession(useAppStore.getState())) {
        return
      }
      useAppStore.getState().captureAllSleepingAgentSessions('periodic')
    }, SLEEPING_AGENT_RESUME_CAPTURE_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [])

  // App remains mounted on Landing, where File→Exit/Ctrl+Q still need a listener (#5144).
  useEffect(() => {
    return window.api.ui.onWindowCloseRequested(dispatchWindowCloseRequest)
  }, [])

  // Periodic scrollback serialization stalled main for seconds (#461); daemon history replaces it (#729). Non-daemon unexpected exits still lose in-session scrollback.
}
