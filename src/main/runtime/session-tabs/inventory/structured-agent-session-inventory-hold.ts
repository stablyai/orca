/** Set and clear inventory uncertainty: reused frames may carry a verdict from before tab restore. */
export function holdAgentSessionInventory<
  T extends {
    agentSessionsUnverifiable?: true
    unverifiableAgentSessionIds?: readonly string[]
  }
>(result: T, unverifiable: boolean, sessionIds?: readonly string[]): T {
  const exact = !unverifiable && sessionIds?.length ? sessionIds : undefined
  const held = unverifiable || exact !== undefined
  if (
    held === (result.agentSessionsUnverifiable === true) &&
    exact === result.unverifiableAgentSessionIds
  ) {
    return result
  }
  const {
    agentSessionsUnverifiable: _held,
    unverifiableAgentSessionIds: _exact,
    ...released
  } = result
  const next = held
    ? {
        ...released,
        agentSessionsUnverifiable: true as const,
        ...(exact ? { unverifiableAgentSessionIds: exact } : {})
      }
    : released
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the optional uncertainty fields changed.
  return next as T
}
