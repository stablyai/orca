/** @see deliverPendingMessagesForLeaf — the emitter, and where liveness is (not) gated. */
export type AgentIdleEdgeEvent = {
  ptyId: string
  worktreeId: string
  leafId: string
  tabId: string
}
