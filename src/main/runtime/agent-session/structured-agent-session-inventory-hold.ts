/** Set and clear inventory uncertainty: reused frames may carry a verdict from before tab restore. */
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
