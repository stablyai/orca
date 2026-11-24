/** App owns the close subscription even without Terminal mounted (#5144); run unsaved-work guards, then rich confirmation or the landing-page fallback. */

import { showShutdownCheckpointFailureToast } from '@/app-shell/shutdown/shutdown-checkpoint-failure-toast'
import { isIntentionalAppRestartInProgress } from '@/app-shell/updates/updater-beforeunload'
import {
  hasUnconfirmedCombinedDiffDrafts,
  readCombinedDiffCloseDrafts,
  type CombinedDiffCloseDrafts
} from '@/components/editor/combined-diff/remember-view/combined-diff-close-drafts'
import {
  formatShutdownCheckpointFailureReason,
  ORCA_RENDERER_SHUTDOWN_CHECKPOINT_ABORTED_EVENT,
  ORCA_RENDERER_UNLOAD_PREVENTED_EVENT,
  publishShutdownCheckpointFailureReason
} from '../../../../shared/app-lifecycle/shutdown/renderer-shutdown-events'

export type WindowCloseAttempt = {
  readonly isQuitting: boolean
  phase: 'guards' | 'workbench' | 'final' | 'sent'
  checkpointStarted: boolean
}

export type WindowCloseRequestHandler = (attempt: WindowCloseAttempt) => void

export type WindowCloseGuard = () => boolean | Promise<boolean>

let activeHandler: WindowCloseRequestHandler | null = null
// Explicit app quits may degrade durable-session checkpoints to avoid trapping the user (#15352); arbitrary unload remains strict.
let windowCloseCheckpointInProgress = false

// A second failed durable write closes anyway, as before this wait existed, so a broken disk cannot trap quit.
let durableCloseCheckpointFailed = false

export function isWindowCloseCheckpointInProgress(): boolean {
  return windowCloseCheckpointInProgress
}

let pendingCloseCheckpoint: Promise<boolean> | null = null

/** Null means an earlier close already awaits this write; main counts its answer for the newer request too. */
export async function prepareWindowCloseCheckpoint(): Promise<boolean | null> {
  if (pendingCloseCheckpoint) {
    await pendingCloseCheckpoint
    return null
  }
  pendingCloseCheckpoint = stageWindowCloseCheckpoint()
  try {
    return await pendingCloseCheckpoint
  } finally {
    pendingCloseCheckpoint = null
  }
}

/** Close proceeds only after the checkpoint it staged is durable; a failed write cancels the close once. */
async function stageWindowCloseCheckpoint(): Promise<boolean> {
  windowCloseCheckpointInProgress = true
  let accepted: boolean
  try {
    accepted = window.dispatchEvent(new Event('beforeunload', { cancelable: true }))
  } finally {
    windowCloseCheckpointInProgress = false
  }
  if (!accepted) {
    return false
  }
  try {
    await window.api.app.awaitBeforeUnloadCheckpoint()
    durableCloseCheckpointFailed = false
    return true
  } catch (error) {
    if (durableCloseCheckpointFailed) {
      console.error('[app] Session snapshot still could not be saved; closing anyway', error)
      return true
    }
    durableCloseCheckpointFailed = true
    publishShutdownCheckpointFailureReason(formatShutdownCheckpointFailureReason(error))
    // Re-stage on the next close attempt instead of trusting the failed checkpoint.
    window.dispatchEvent(new Event(ORCA_RENDERER_SHUTDOWN_CHECKPOINT_ABORTED_EVENT))
    return false
  }
}

const closeGuards = new Set<WindowCloseGuard>()
let activeAttempt: WindowCloseAttempt | null = null
let confirmedDrafts: CombinedDiffCloseDrafts | null = null
let confirmDraftDiscard: (() => Promise<boolean>) | null = null

export function registerCombinedDiffClosePrompt(confirm: () => Promise<boolean>): () => void {
  confirmDraftDiscard = confirm
  const beforeUnload = (event: BeforeUnloadEvent): void => {
    // Input can arrive while the close IPC crosses to main.
    if (!event.isTrusted || !confirmedDrafts) {
      return
    }
    try {
      if (hasUnconfirmedCombinedDiffDrafts(readCombinedDiffCloseDrafts(), confirmedDrafts)) {
        event.preventDefault()
      }
    } catch (error) {
      event.preventDefault()
      console.error('[app] Could not verify drafts before unload:', error)
    }
  }
  const reset = (): void => {
    if (activeAttempt?.phase === 'sent') {
      activeAttempt = null
      confirmedDrafts = null
    }
  }
  window.addEventListener('beforeunload', beforeUnload)
  window.addEventListener(ORCA_RENDERER_UNLOAD_PREVENTED_EVENT, reset)
  return () => {
    confirmDraftDiscard = null
    window.removeEventListener('beforeunload', beforeUnload)
    window.removeEventListener(ORCA_RENDERER_UNLOAD_PREVENTED_EVENT, reset)
  }
}

export function isWindowCloseAttemptCurrent(attempt: WindowCloseAttempt): boolean {
  return activeAttempt === attempt
}

export function cancelWindowCloseRequest(attempt: WindowCloseAttempt): void {
  if (!isWindowCloseAttemptCurrent(attempt)) {
    return
  }
  activeAttempt = null
  confirmedDrafts = null
  try {
    window.api.ui.cancelWindowClose()
  } finally {
    if (attempt.checkpointStarted) {
      window.dispatchEvent(new Event(ORCA_RENDERER_UNLOAD_PREVENTED_EVENT))
    }
  }
}

export function abandonWorkbenchWindowClose(): void {
  if (activeAttempt?.phase === 'workbench') {
    cancelWindowCloseRequest(activeAttempt)
  }
}

export function sendWindowCloseConfirmation(attempt: WindowCloseAttempt): void {
  if (isWindowCloseAttemptCurrent(attempt) && attempt.phase !== 'sent') {
    attempt.phase = 'sent'
    window.api.ui.confirmWindowClose()
  }
}

function failWindowCloseAttempt(attempt: WindowCloseAttempt, error: unknown): void {
  if (isWindowCloseAttemptCurrent(attempt)) {
    console.error('[app] Window close failed:', error)
    cancelWindowCloseRequest(attempt)
  }
}

export async function confirmInteractiveWindowClose(attempt: WindowCloseAttempt): Promise<void> {
  if (
    !isWindowCloseAttemptCurrent(attempt) ||
    attempt.phase === 'final' ||
    attempt.phase === 'sent'
  ) {
    return
  }
  attempt.phase = 'final'
  try {
    let checkpointReady = false
    let confirmed: CombinedDiffCloseDrafts = new Map()
    const interactive = !isIntentionalAppRestartInProgress()
    while (isWindowCloseAttemptCurrent(attempt)) {
      const current = interactive ? readCombinedDiffCloseDrafts() : confirmed
      if (hasUnconfirmedCombinedDiffDrafts(current, confirmed)) {
        if (!(await confirmDraftDiscard?.())) {
          cancelWindowCloseRequest(attempt)
          return
        }
        confirmed = current
        continue
      }
      if (checkpointReady) {
        confirmedDrafts = interactive ? confirmed : null
        sendWindowCloseConfirmation(attempt)
        return
      }
      attempt.checkpointStarted = true
      const accepted = await prepareWindowCloseCheckpoint()
      if (!isWindowCloseAttemptCurrent(attempt)) {
        return
      }
      if (accepted === false) {
        showShutdownCheckpointFailureToast()
        cancelWindowCloseRequest(attempt)
        return
      }
      checkpointReady = accepted === true
    }
  } catch (error) {
    failWindowCloseAttempt(attempt, error)
  }
}

/** Unmounting Terminal hands rich close handling back to App’s fallback. */
export function setWindowCloseRequestHandler(handler: WindowCloseRequestHandler | null): void {
  activeHandler = handler
}

export function getWindowCloseRequestHandler(): WindowCloseRequestHandler | null {
  return activeHandler
}

export function registerWindowCloseGuard(guard: WindowCloseGuard): () => void {
  closeGuards.add(guard)
  return () => {
    closeGuards.delete(guard)
  }
}

async function runWindowCloseGuards(): Promise<boolean> {
  for (const guard of closeGuards) {
    if (!(await guard())) {
      return false
    }
  }
  return true
}

/** Run pre-close guards, then the mounted rich handler; with no workbench, confirm directly because no tabs need protection (#5144). */
export async function dispatchWindowCloseRequest(data: { isQuitting: boolean }): Promise<void> {
  if (activeAttempt) {
    return
  }
  const attempt: WindowCloseAttempt = { ...data, phase: 'guards', checkpointStarted: false }
  activeAttempt = attempt
  try {
    if (!(await runWindowCloseGuards())) {
      cancelWindowCloseRequest(attempt)
      return
    }
    if (!isWindowCloseAttemptCurrent(attempt)) {
      return
    }
    if (activeHandler) {
      attempt.phase = 'workbench'
      activeHandler(attempt)
      return
    }
    await confirmInteractiveWindowClose(attempt)
  } catch (error) {
    failWindowCloseAttempt(attempt, error)
  }
}
