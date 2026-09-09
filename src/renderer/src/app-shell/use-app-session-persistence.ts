import { useEffect } from 'react'
import { useAppStore } from '../store'
import {
  isDirectSshRemoteWorkspaceApplyInProgress,
  onDirectSshRemoteWorkspaceApplyWindowClosed
} from '../hooks/remote-workspace-snapshot-apply'
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
import type { AppState } from '../store/types'
import { applyRemoteWorkspacePushStatus } from '../hooks/remote-workspace-push-status'

// Why: bound the resume-record loss window on a hard kill to ~1 min; capture skips unchanged records so per-tick cost is negligible.
const SLEEPING_AGENT_RESUME_CAPTURE_INTERVAL_MS = 60_000

type RemoteWorkspaceUploadAuthority = {
  targetId: string
  revision: number
  updatedAt?: number
  hostObservationToken: string
}

function captureRemoteWorkspaceUploadAuthorities(
  state: AppState
): RemoteWorkspaceUploadAuthority[] {
  return Array.from(state.remoteWorkspaceHydratedTargetIds).flatMap((targetId) => {
    const syncStatus = state.remoteWorkspaceSyncStatusByTargetId[targetId]
    const revision = syncStatus?.revision
    const hostObservationToken = syncStatus?.hostObservationToken
    if (
      syncStatus?.phase === 'conflict' ||
      typeof revision !== 'number' ||
      !Number.isSafeInteger(revision) ||
      revision < 0 ||
      typeof hostObservationToken !== 'string' ||
      hostObservationToken.length === 0
    ) {
      return []
    }
    return [
      {
        targetId,
        revision,
        updatedAt: syncStatus.updatedAt,
        hostObservationToken
      }
    ]
  })
}

function remoteWorkspaceUploadAuthorityIsCurrent(
  state: AppState,
  authority: RemoteWorkspaceUploadAuthority
): boolean {
  const status = state.remoteWorkspaceSyncStatusByTargetId[authority.targetId]
  return (
    state.remoteWorkspaceHydratedTargetIds.has(authority.targetId) &&
    status?.phase !== 'conflict' &&
    status?.hostObservationToken === authority.hostObservationToken
  )
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
      subscribeToPersistGateOpen: onDirectSshRemoteWorkspaceApplyWindowClosed,
      persist: ({ patch }) => {
        const state = useAppStore.getState()
        // Why: route each host's worktree-scoped slice to its own partition; return the local write so the remote-workspace upload chain below keeps its ordering.
        const localWrite = patchWorkspaceSessionByHost(window.api.session, patch, state)
        void localWrite
        const uploadAuthorities = captureRemoteWorkspaceUploadAuthorities(state)
        if (uploadAuthorities.length > 0) {
          void (async () => {
            try {
              await localWrite
              const currentState = useAppStore.getState()
              const currentAuthorities = uploadAuthorities.filter((authority) =>
                remoteWorkspaceUploadAuthorityIsCurrent(currentState, authority)
              )
              if (currentAuthorities.length === 0) {
                return
              }
              const hydratedTargetIds = currentAuthorities.map(({ targetId }) => targetId)
              const expectedRevisionsByTargetId = Object.fromEntries(
                currentAuthorities.map(({ targetId, revision }) => [targetId, revision])
              )
              const expectedHostObservationTokensByTargetId = Object.fromEntries(
                currentAuthorities.map(({ targetId, hostObservationToken }) => [
                  targetId,
                  hostObservationToken
                ])
              )
              const results = await window.api.remoteWorkspace?.setForConnectedTargets({
                hydratedTargetIds,
                expectedRevisionsByTargetId,
                expectedHostObservationTokensByTargetId
              })
              const resultState = useAppStore.getState()
              const currentAuthorityByTargetId = new Map(
                currentAuthorities.map((authority) => [authority.targetId, authority])
              )
              for (const { targetId, result } of results ?? []) {
                const authority = currentAuthorityByTargetId.get(targetId)
                if (authority && remoteWorkspaceUploadAuthorityIsCurrent(resultState, authority)) {
                  applyRemoteWorkspacePushStatus(resultState, targetId, result, authority)
                }
              }
            } catch (err) {
              const errorState = useAppStore.getState()
              for (const authority of uploadAuthorities) {
                if (!remoteWorkspaceUploadAuthorityIsCurrent(errorState, authority)) {
                  continue
                }
                const currentStatus =
                  errorState.remoteWorkspaceSyncStatusByTargetId[authority.targetId]
                errorState.setRemoteWorkspaceSyncStatus(authority.targetId, {
                  phase: 'error',
                  direction: 'push',
                  revision: currentStatus?.revision ?? authority.revision,
                  updatedAt: currentStatus?.updatedAt ?? authority.updatedAt,
                  hostObservationToken: authority.hostObservationToken,
                  message: err instanceof Error ? err.message : 'Workspace upload failed'
                })
              }
            }
          })()
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
      // Why: agent provider session ids live only in agentStatusByPaneKey,
      // which is in-memory. Capture them into the persisted sleeping-session
      // map so a daemon/session death while the app is closed can still
      // cold-restore via the agent's resume command (#5232).
      captureSleepingAgentSessions: () =>
        useAppStore.getState().captureAllSleepingAgentSessions('quit'),
      // Why: re-read state after capture() calls populated scrollback buffers
      // into the store via Zustand setters. The shouldCaptureSession read is
      // only for the gating flags and would miss those updates.
      buildSessionSnapshots: () => {
        const freshState = useAppStore.getState()
        return buildWorkspaceSessionHostSnapshots(
          buildWorkspaceSessionPayload(freshState),
          freshState
        )
      },
      buildUiPatch: () => buildActiveViewUnloadPatch(useAppStore.getState()),
      hasDirtyOpenFiles: () => useAppStore.getState().openFiles.some((file) => file.isDirty),
      // Why: an app-level quit degrades too — the pre-fix alternative was a quit
      // the user could only complete with SIGKILL, which loses strictly more (#15352).
      isDegradableShutdownInProgress: () =>
        isIntentionalAppRestartInProgress() || isWindowCloseCheckpointInProgress(),
      stageBeforeUnloadSync: (args) => window.api.app.stageBeforeUnloadSync(args)
    })
    const shutdownCheckpoint = createShutdownCheckpointGuard(
      shutdownCheckpointPersist.run,
      shutdownCheckpointPersist.abandonAttempt
    )
    const persistBeforeUnload = createShutdownCheckpointBeforeUnloadHandler(shutdownCheckpoint)
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
