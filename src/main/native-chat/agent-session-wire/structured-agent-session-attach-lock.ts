// How an attach's steps meet the session's serialize. A client attach already holds it, so every
// step runs in place; an agent start runs outside it, races each wait with its abort signal, and
// commits each write under it after re-checking its fence (`structured-agent-session-start-flight`).

export type StructuredAgentSessionAttachLock = {
  readonly signal: AbortSignal
  /** A wait on something outside Orca's state: a probe, a resolver, a provider read. */
  wait: <T>(work: Promise<T>) => Promise<T>
  /** A write to the session's state, which never waits on a process. */
  commit: <T>(step: () => Promise<T>) => Promise<T>
}

/** For a caller already inside the session's serialize. */
export function heldStructuredAgentSessionAttachLock(
  signal: AbortSignal = new AbortController().signal
): StructuredAgentSessionAttachLock {
  return { signal, wait: (work) => work, commit: (step) => step() }
}
