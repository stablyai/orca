/** Read-only questions the host asks an adapter about its live child; none change provider state. */
export type StructuredAgentSessionLiveChildReads = {
  /** Derive unanswered retained work from the live child; false without one. */
  holdsDispatch?(sessionId: string): boolean
  /** The root turn the live child is running, null when idle; absent when the agent cannot say. */
  liveTurnId?(sessionId: string): string | null | undefined
  /** Undefined without a live child; then the host conservatively treats unanswered sends as held. */
  heldSends?(sessionId: string): ReadonlySet<string> | undefined
  /** Host path the live child moved its work to (e.g. EnterWorktree); undefined is its launch directory. */
  workingDirectory?(sessionId: string): string | undefined
}
