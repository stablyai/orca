import type { OrchestrationDb } from '../../orchestration/db'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RunRow } from '../../orchestration/types'

export type SendRecipientWarningCode =
  | 'no_live_terminal'
  | 'recipient_reads_other_mailbox'
  | 'recipient_outside_run'
  | 'recipient_unreachable'

export type SendRecipientWarning = {
  code: SendRecipientWarningCode
  recipient: string
  message: string
}

export type TerminalRecipientReach = {
  /** False only when nothing — no live pane, no active Dispatch — can ever surface the row. */
  deliverable: boolean
  warning?: SendRecipientWarning
}

/**
 * A legacy `to_handle` row is readable through `orchestration check` only when the recipient
 * still reads the per-handle mailbox. A coordinator reads `run:<id>` and a worker reads
 * `dispatch:<id>`, and neither query returns bare-handle rows, so an accepted address is not
 * the same thing as a delivered message (#13363).
 */
export function resolveTerminalRecipientReach(params: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  handle: string
  run: RunRow | undefined
}): TerminalRecipientReach {
  const { runtime, db, handle, run } = params
  const paneKey = runtime.getTerminalPaneKey(handle)
  const activeDispatch = db.getActiveDispatchForTerminal(handle)
  if (!paneKey) {
    // Why: the adopted Run retains pre-update work for inspection and its handles are expected
    // to be dead, so refusing there would drop a retained worker's report instead of keeping it.
    const retainedLegacyRun = run !== undefined && run.id === db.getLegacyAdoption()?.adopted_run_id
    if (!activeDispatch && !retainedLegacyRun) {
      return {
        deliverable: false,
        warning: {
          code: 'no_live_terminal',
          recipient: handle,
          message: `No live terminal holds ${handle} and no active Dispatch names it, so nothing will read this message.`
        }
      }
    }
    // Why: an in-flight worker whose pane key is momentarily unresolvable must still receive
    // status mail (#13458); it just cannot be pushed until that pane comes back.
    return {
      deliverable: true,
      warning: {
        code: 'no_live_terminal',
        recipient: handle,
        message: activeDispatch
          ? `No live terminal holds ${handle}. The message waits for the pane of Dispatch ${activeDispatch.id} to reattach.`
          : `No live terminal holds ${handle}. Run ${run?.id} is retained pre-update state, so the message is stored for inspection only.`
      }
    }
  }

  const boundRun = db.getCurrentRunForPane(paneKey)
  const identityDispatch = db.getActiveDispatchForIdentity(handle, paneKey)
  const polledMailbox = boundRun
    ? `run:${boundRun.id}`
    : identityDispatch
      ? `dispatch:${identityDispatch.id}`
      : undefined
  if (polledMailbox) {
    return {
      deliverable: true,
      warning: {
        code: 'recipient_reads_other_mailbox',
        recipient: handle,
        message: `${handle} reads ${polledMailbox}, and that mailbox never returns messages addressed to a bare terminal handle. Address ${polledMailbox} instead.`
      }
    }
  }

  // Why: a Run participant already returned above through its own mailbox, so anything left is
  // outside the Run this row is filed under — including a coordinator handle that run-use
  // replaced, which stays a live terminal and hides the takeover from the sender.
  if (run && run.coordinator_handle !== handle) {
    return {
      deliverable: true,
      warning: {
        code: 'recipient_outside_run',
        recipient: handle,
        message: `${handle} is neither the coordinator nor an active worker of Run ${run.id}. The message is filed under that Run but only ${handle} can read it, so the Run's coordinator never sees it.`
      }
    }
  }

  return { deliverable: true }
}

/**
 * Group membership is discovered, not chosen, so one unreachable member must not fail a
 * broadcast to the live ones. The recipient is dropped before insertion and named here
 * instead, which is what distinguishes it from `no_live_terminal` on a row that was stored.
 */
export function unreachableRecipientWarning(handle: string): SendRecipientWarning {
  return {
    code: 'recipient_unreachable',
    recipient: handle,
    message: `No live terminal holds ${handle} and no active Dispatch names it, so no message was created for that recipient.`
  }
}
