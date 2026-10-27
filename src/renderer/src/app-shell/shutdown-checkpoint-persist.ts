import type { PersistedUIState } from '../../../shared/persisted-ui-state-types'
import { formatShutdownCheckpointFailureReason } from '../../../shared/renderer-shutdown-events'
import type { WorkspaceSessionHostSnapshot } from '../lib/workspace-session-host-persistence'
import { recordRendererCrashBreadcrumb } from '../lib/crash-breadcrumb-recorder'

export type ShutdownCheckpointStageArgs = {
  sessions: WorkspaceSessionHostSnapshot[]
  ui: Partial<PersistedUIState>
}

export type ShutdownCheckpointPersistDeps = {
  shouldCaptureSession: () => boolean
  /** Per-pane failures are already swallowed inside the capture loop. */
  captureTerminalBuffers: () => void
  captureSleepingAgentSessions: () => void
  buildSessionSnapshots: () => WorkspaceSessionHostSnapshot[]
  buildUiPatch: () => Partial<PersistedUIState>
  hasDirtyOpenFiles: () => boolean
  /** Allow durable-session fallback during intentional restart or app quit/close, subject to draft protection. */
  isDegradableShutdownInProgress: () => boolean
  stageBeforeUnloadSync: (args: ShutdownCheckpointStageArgs) => void
}

export type ShutdownCheckpointPersist = {
  run: () => void
  abandonAttempt: () => void
}

/** Capture renderer state and stage it through one main call. Preserve attempt state so full-stage failure blocks once before eligible fallback; abandonAttempt resets it after canceled shutdown. */
export function createShutdownCheckpointPersist(
  deps: ShutdownCheckpointPersistDeps
): ShutdownCheckpointPersist {
  let fullStagingFailedOnPriorAttempt = false
  const run = (): void => {
    const shouldCaptureSession = deps.shouldCaptureSession()
    if (shouldCaptureSession) {
      deps.captureTerminalBuffers()
      try {
        deps.captureSleepingAgentSessions()
      } catch (error) {
        // Continue with weaker live-origin records when quit capture fails; blocking stranded updates and forced quits lost more state (STA-5505).
        console.error('[app] Sleeping-agent quit capture failed; continuing checkpoint', error)
        recordRendererCrashBreadcrumb('renderer_shutdown_sleeping_capture_failed', {
          message: formatShutdownCheckpointFailureReason(error)
        })
      }
    }
    // Dirty drafts exist only in the full snapshot and must never be traded for an update.
    const canDegradeToDurableSession = (): boolean =>
      deps.isDegradableShutdownInProgress() && !deps.hasDirtyOpenFiles()
    let sessionSnapshots: WorkspaceSessionHostSnapshot[] = []
    let degraded = false
    try {
      sessionSnapshots = shouldCaptureSession ? deps.buildSessionSnapshots() : []
    } catch (error) {
      if (!canDegradeToDurableSession()) {
        throw error
      }
      console.error('[app] Full renderer session snapshot failed; using durable session', error)
      degraded = true
    }
    try {
      deps.stageBeforeUnloadSync({
        sessions: degraded ? [] : sessionSnapshots,
        ui: deps.buildUiPatch()
      })
    } catch (error) {
      // A durable-only stage has nothing safer left to fall back to.
      if (degraded) {
        throw error
      }
      // Retry once before degrading to preserve fresh scrollback on transient failure. Only eligible shutdowns arm fallback; unrelated unloads cannot consume a later restart’s retry.
      const keepBlocking = !fullStagingFailedOnPriorAttempt || !canDegradeToDurableSession()
      if (canDegradeToDurableSession()) {
        fullStagingFailedOnPriorAttempt = true
      }
      if (keepBlocking) {
        throw error
      }
      console.error(
        '[app] Staging the full renderer session failed again; using durable session',
        error
      )
      deps.stageBeforeUnloadSync({ sessions: [], ui: deps.buildUiPatch() })
    }
    fullStagingFailedOnPriorAttempt = false
  }
  return {
    run,
    abandonAttempt: () => {
      fullStagingFailedOnPriorAttempt = false
    }
  }
}
