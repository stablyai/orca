// Why a submission is in doubt, and whether Orca may put the message on the
// wire a second time.
//
// `unknown` is never raised by elapsed time; what survives is a process fact.
// But a process fact that ends the WAIT is not the same claim as one that
// proves the message never reached a provider, and only the second justifies a
// re-delivery. The allowlist below names the reasons that carry the stronger
// claim, and it is deliberately FAIL-CLOSED: a reason nobody adds to it is
// refused. Refusing a legitimate retry costs the user one re-typed message;
// allowing an illegitimate one silently sends the model a second copy, which is
// the harm this whole path exists to remove. When those two are in tension,
// choose the re-type.

/** A previous process wrote the message and died before learning its outcome. */
export const DISPATCH_DOUBT_HOST_RESTARTED = 'host_restarted_before_acknowledgement'

/** The child that would have acknowledged the message exited first. */
export const DISPATCH_DOUBT_PROVIDER_EXITED = 'provider_exited_before_acknowledgement'

/** The adapter took the message and only the journal write failed after it. */
export const DISPATCH_DOUBT_PERSISTENCE_FAILED = 'dispatch_result_persistence_failed'

/** A retry was durably armed but had not yet recorded its dispatch outcome. */
export const DISPATCH_DOUBT_RETRY_IN_PROGRESS = 'dispatch_retry_in_progress'

/** Codex owns a turn it started but did not name, because its turn-start still
 *  settles on a deadline. Delete this once Codex settles on the app-server's
 *  turn-start response instead; until then this reason is never re-delivered,
 *  which is what the allowlist below already does by omitting it. */
export const DISPATCH_DOUBT_CODEX_TURN_UNNAMED =
  'codex app-server started a turn it did not name in time'

/** The transport refused the frame; the underlying error follows the colon. */
export const DISPATCH_DOUBT_WRITE_FAILED = 'provider_write_failed'

/** The SDK took the frame, but its input pump did not prove whether the write completed. */
export const DISPATCH_DOUBT_WRITE_OUTCOME_UNKNOWN = 'provider_write_outcome_unknown'

export function dispatchWriteFailureReason(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  return `${DISPATCH_DOUBT_WRITE_FAILED}: ${detail}`
}

export function dispatchWriteOutcomeUnknownReason(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  return `${DISPATCH_DOUBT_WRITE_OUTCOME_UNKNOWN}: ${detail}`
}

/**
 * The allowlist. True only where the frame is known never to have been taken by
 * a provider, so sending it again is a first delivery rather than a second.
 *
 * A dead child and a dead host are NOT on this list. Both end the wait, neither
 * proves non-delivery: the message was already written to that child's stdin,
 * and Claude resumes the same provider session by id, so a message that child
 * processed before dying is in the conversation Orca resumes. Deciding those
 * needs the message matched against provider history — which is exactly what
 * `journal-submission-reconciler.ts` does, and that module has no caller yet.
 */
export function dispatchDoubtProvesUndelivered(reason: string | null | undefined): boolean {
  return (
    reason === DISPATCH_DOUBT_WRITE_FAILED ||
    reason?.startsWith(`${DISPATCH_DOUBT_WRITE_FAILED}: `) === true
  )
}
