/**
 * Answers whether a snapshot bound for a client may be read as this runtime's chat inventory.
 *
 * Sets *and* clears, like the client-hosted page hold beside it, because a frame is built once
 * and may already carry an answer from before the last tab restore.
 */
export function holdAgentSessionInventory<T extends { agentSessionsUnverifiable?: true }>(
  result: T,
  unverifiable: boolean
): T {
  if (unverifiable === (result.agentSessionsUnverifiable === true)) {
    return result
  }
  if (unverifiable) {
    return { ...result, agentSessionsUnverifiable: true as const }
  }
  const { agentSessionsUnverifiable: _held, ...released } = result
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the optional hold field was removed, so the rest is still a T.
  return released as T
}
