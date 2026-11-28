/** One `agentOrchestrationChanged` per tick, after the writes that fired it commit, however many there were. */
export function createAgentOrchestrationChangeNotice(emit: () => void): () => void {
  let queued = false
  return () => {
    if (queued) {
      return
    }
    queued = true
    queueMicrotask(() => {
      queued = false
      emit()
    })
  }
}
