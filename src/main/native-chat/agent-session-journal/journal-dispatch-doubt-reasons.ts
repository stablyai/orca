// Why a submission is `unknown` — the one state that admits it cannot tell.
//
// `unknown` is never raised by elapsed time; what survives is a process fact that
// ENDS THE WAIT without answering it. Nothing here proves a message reached a
// provider, and nothing here proves it did not: a fact that proves non-delivery
// is a rejection and lives in `journal-dispatch-rejection-reasons.ts`.
//
// That leaves the invariant this file exists to state: Orca NEVER re-delivers a
// message under its own id on the strength of an `unknown`, whatever the reason
// says. A retry that could be a second delivery is the harm this whole path
// exists to remove, and a user who wants the message sent anyway rotates the id
// — one re-typed message, and a first delivery by construction.

/** A previous process wrote the message and died before learning its outcome. */
export const DISPATCH_DOUBT_HOST_RESTARTED = 'host_restarted_before_acknowledgement'

/** The child that would have acknowledged the message exited first. */
export const DISPATCH_DOUBT_PROVIDER_EXITED = 'provider_exited_before_acknowledgement'

/** The adapter took the message and only the journal write failed after it. */
export const DISPATCH_DOUBT_PERSISTENCE_FAILED = 'dispatch_result_persistence_failed'

/** Codex owns a turn it started but did not name, because its turn-start still
 *  settles on a deadline. The turn IS running, so this must never be treated as
 *  proof of non-delivery. Delete it once Codex settles on the app-server's
 *  turn-start response instead. */
export const DISPATCH_DOUBT_CODEX_TURN_UNNAMED =
  'codex app-server started a turn it did not name in time'

/** The SDK took the frame, but its input pump did not prove whether the write completed. */
export const DISPATCH_DOUBT_WRITE_OUTCOME_UNKNOWN = 'provider_write_outcome_unknown'

export function dispatchWriteOutcomeUnknownReason(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  return `${DISPATCH_DOUBT_WRITE_OUTCOME_UNKNOWN}: ${detail}`
}
