/** Host-only request identity; it never enters a status or wire frame. */
export type StructuredAgentSessionStatusObserverOptions = {
  replay: boolean
  firstInputSubmissionKey?: string | null
}
