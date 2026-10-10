/**
 * "Is this handle a live orchestration identity?" — answered for BOTH lanes.
 *
 * The CLI asked that question by calling `terminal.show`, which is a PTY verb: it resolves a pane,
 * a ptyId and a preview. A structured worker has none of those, so `showTerminal` missed, threw
 * `terminal_handle_stale`, and the caller concluded the handle the child was BORN with was dead —
 * failing twelve coordinator verbs for a worker whose own preamble tells it to run them.
 *
 * So the identity question gets its own probe, returning a handle and a boolean and nothing
 * writable. `terminal.show` deliberately still refuses a structured handle: synthesising
 * `ptyId`/`leafId`/`paneRuntimeId` would hand every public terminal verb something that looks
 * writable and is not.
 *
 * The PTY half is EXACTLY today's `terminal.show` liveness test, `getLiveLeafForHandle` included,
 * so its `rendererGraphEpoch` re-check still runs. That check is the whole point of validating at
 * all — a long-lived shell keeps a stale `ORCA_TERMINAL_HANDLE` across a window reload — and a
 * cheaper probe that skipped it (`getPaneKeyForTerminalHandle`, say) would quietly start passing
 * handles that fail today.
 */

export type RuntimeTerminalIdentity = {
  handle: string
  live: boolean
}

/** The one error code that means "not live" rather than "could not look". */
export const TERMINAL_HANDLE_STALE_ERROR = 'terminal_handle_stale'

export type TerminalIdentityProbes = {
  /** A structured worker of THIS runtime, proven through its durable record. */
  isLiveStructuredWorker: () => boolean
  hasLivePty: () => boolean
  /** Today's leaf check; throws `terminal_handle_stale` for a stale or reloaded handle. */
  assertLiveLeaf: () => void
}

export function resolveTerminalIdentityFromProbes(
  handle: string,
  probes: TerminalIdentityProbes
): RuntimeTerminalIdentity {
  if (probes.isLiveStructuredWorker() || probes.hasLivePty()) {
    return { handle, live: true }
  }
  try {
    probes.assertLiveLeaf()
    return { handle, live: true }
  } catch (error) {
    if (error instanceof Error && error.message === TERMINAL_HANDLE_STALE_ERROR) {
      return { handle, live: false }
    }
    // Anything else — a graph that is not ready yet — is "could not look", and must propagate
    // exactly as it does through `terminal.show` today rather than being read as a dead handle.
    throw error
  }
}
