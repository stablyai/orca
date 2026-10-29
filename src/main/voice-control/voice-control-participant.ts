import type { OrchestrationDb } from '../runtime/orchestration/db'

/**
 * The control's orchestration identity: one Run per voice session with a synthetic
 * coordinator handle and no pane. The run's `run:<id>` mailbox is where kicked-off
 * agents' reports land; the SQL coordinator-mail trigger also rewrites
 * anything addressed to the bare handle below. No principal registration exists or is
 * needed — a bound run IS the mailbox.
 */

export const VOICE_CONTROL_HANDLE = 'voice-control'

export type VoiceControlRun = {
  runId: string
  mailboxHandle: string
}

export function openVoiceControlRun(db: OrchestrationDb): VoiceControlRun {
  const run = db.createRun({
    objective: 'Voice control session',
    coordinatorHandle: VOICE_CONTROL_HANDLE,
    coordinatorPaneKey: null
  })
  // createRun's unbind matches on pane/session identity, which a handle-only coordinator
  // lacks — without this, every session leaks a binding and the bare handle goes ambiguous.
  db.forgetRunCoordinatorHandlesExcept(VOICE_CONTROL_HANDLE, run.id)
  return { runId: run.id, mailboxHandle: `run:${run.id}` }
}
