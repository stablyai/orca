// Client attach holds serialization; background starts wait outside it and fence each serialized commit.

export type StructuredAgentSessionAttachLock = {
  readonly signal: AbortSignal
  /** External work: probes, resolvers and provider reads. */
  wait: <T>(work: Promise<T>) => Promise<T>
  /** State commits must never wait on a process. */
  commit: <T>(step: () => Promise<T>) => Promise<T>
}

export function heldStructuredAgentSessionAttachLock(
  signal: AbortSignal = new AbortController().signal
): StructuredAgentSessionAttachLock {
  return { signal, wait: (work) => work, commit: (step) => step() }
}
