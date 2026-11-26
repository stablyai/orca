import { useEffect } from 'react'
import { useAppStore } from '../../store/index'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/workspace-layout/layout-owner-switch'
import { createSessionWriteSubscriber } from '../../lib/workspace/persistence/session-write-subscriber'
import { buildActiveViewUnloadPatch } from '../startup/active-view-persist'
import {
  isIntentionalAppRestartInProgress,
  registerUpdaterBeforeUnloadBypass
} from '../updates/updater-beforeunload'
import {
  buildWorkspaceSessionPayload,
  shouldPersistWorkspaceSession
} from '../../lib/workspace/persistence/workspace-session'
import {
  buildWorkspaceSessionHostSnapshots,
  patchWorkspaceSessionByHost
} from '../../lib/workspace/persistence/workspace-session-host-persistence'
import {
  desktopRelaysSupported,
  forgetAcknowledgedDesktopRelays,
  probeDesktopRelays
} from '../../lib/workspace/persistence/desktop-relay-writes'
import type { DesktopRelayWrite } from '../../../../shared/workspace-session/desktop-relay-write'
import { windowAcknowledgedSessionEntries } from '../../lib/workspace/persistence/workspace-session-acknowledged-entries'
import {
  createShutdownCheckpointBeforeUnloadHandler,
  createShutdownCheckpointGuard
} from '../shutdown/shutdown-checkpoint-guard'
import { showShutdownCheckpointFailureToast } from '../shutdown/shutdown-checkpoint-failure-toast'
import { isPairedWebClientWindow } from '../chrome/desktop-window-chrome'
import { createShutdownCheckpointPersist } from '../shutdown/shutdown-checkpoint-persist'
import { shutdownBufferCaptures } from '../../components/terminal-pane/snapshots/shutdown-buffer-captures'
import {
  dispatchWindowCloseRequest,
  isWindowCloseCheckpointInProgress
} from '../shutdown/window-close-request-coordinator'
import {
  ORCA_APP_RESTART_ABORTED_EVENT,
  ORCA_UPDATER_QUIT_AND_INSTALL_ABORTED_EVENT
} from '../../../../shared/updater/updater-renderer-events'
import {
  ORCA_NATIVE_UNLOAD_FAILED_EVENT,
  ORCA_RENDERER_SHUTDOWN_CHECKPOINT_ABORTED_EVENT,
  ORCA_RENDERER_UNLOAD_PREVENTED_EVENT
} from '../../../../shared/app-lifecycle/shutdown/renderer-shutdown-events'

// Capture unchanged-skipping resume records each minute to bound hard-kill loss.
const SLEEPING_AGENT_RESUME_CAPTURE_INTERVAL_MS = 60_000

/** Persist renderer sessions through per-host debounced writes and a synchronous shutdown checkpoint. */
export function useAppSessionPersistence(): void {
  useEffect(() => registerUpdaterBeforeUnloadBypass(), [])

  // Subscribe outside React: disk persistence needs no renders on tab/file/browser changes.
  useEffect(() => {
    // A remount starts from whole fields again.
    windowAcknowledgedSessionEntries.forget()
    forgetAcknowledgedDesktopRelays()
    probeDesktopRelays(window.api.session)
    return createSessionWriteSubscriber({
      store: useAppStore,
      onPersistError: (error) => console.warn('[session] Session patch failed:', error),
      persist: ({ patch }) => {
        // Route each host’s workspace slice to its own partition.
        return patchWorkspaceSessionByHost(
          window.api.session,
          patch,
          useAppStore.getState(),
          windowAcknowledgedSessionEntries
        ).written
      }
    })
  }, [])

  // Capture renderer-owned state into one synchronous shutdown checkpoint.
  useEffect(() => {
    // Quit can trigger synthetic and native beforeunload. Preserve the first capture before PTY exits unmount panes and empty their buffers.
    let stagedRelays: DesktopRelayWrite['hosts'] | undefined
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
        const { snapshots, desktopRelays } = buildWorkspaceSessionHostSnapshots(
          buildWorkspaceSessionPayload(freshState),
          freshState,
          // Unsettled at unload: relay ids stay in the snapshots, as for an older main.
          desktopRelaysSupported(window.api.session) === true
        )
        stagedRelays = desktopRelays?.hosts
        return snapshots
      },
      buildUiPatch: () => buildActiveViewUnloadPatch(useAppStore.getState()),
      hasDirtyOpenFiles: () => useAppStore.getState().openFiles.some((file) => file.isDirty),
      // Allow quit fallback too; SIGKILL to escape a blocked quit loses more state (#15352).
      isDegradableShutdownInProgress: () =>
        isIntentionalAppRestartInProgress() || isWindowCloseCheckpointInProgress(),
      // Relay ids left the snapshots; a stage without them (durable fallback) leaves main's as they are.
      stageBeforeUnloadSync: (args) =>
        window.api.app.stageBeforeUnloadSync(
          args.sessions.length > 0 && stagedRelays ? { ...args, desktopRelays: stagedRelays } : args
        )
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
    const reportNativeUnloadFailure = (): void => showShutdownCheckpointFailureToast('reload')
    window.addEventListener(ORCA_NATIVE_UNLOAD_FAILED_EVENT, reportNativeUnloadFailure)
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
      window.removeEventListener(ORCA_NATIVE_UNLOAD_FAILED_EVENT, reportNativeUnloadFailure)
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
