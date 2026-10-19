/**
 * When each environment's ready control socket last heard from its server. A leaf module: the
 * serving gate reads it without importing the connection cache, which imports the gate back.
 */
const sources = new Map<string, () => number | null>()

export function setSharedControlAnswerSource(
  environmentId: string,
  source: () => number | null
): void {
  sources.set(environmentId, source)
}

export function clearSharedControlAnswerSource(environmentId: string): void {
  sources.delete(environmentId)
}

/** Null while there is no ready control socket for the environment. */
export function getRemoteRuntimeSharedControlAnsweredAt(environmentId: string): number | null {
  return sources.get(environmentId)?.() ?? null
}
