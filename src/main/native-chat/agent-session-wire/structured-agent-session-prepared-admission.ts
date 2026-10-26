/** Local preparation only: no journal or wire representation. */
export type StructuredAgentSessionPreparedAdmission = (
  offer: (requestedAt: number) => Promise<void>,
  currentTurn: () => string | null
) => Promise<void>
