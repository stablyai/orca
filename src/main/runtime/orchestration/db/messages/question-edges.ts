// The writes an agent question's notice decision depends on, told after the write that made them
// commits (node:sqlite is synchronous, so a microtask runs after it, or after its rollback).

export type QuestionEdge =
  /** A question was taken by this taker key. */
  | { kind: 'take'; taker: string }
  /** These messages were read, delivered, or ended a handover. */
  | { kind: 'mail'; ids: readonly string[] }
  /** A delivery pass for this mailbox ended. */
  | { kind: 'mailbox'; mailbox: string }
  /** A pointer typed into this terminal settled. */
  | { kind: 'pane'; ptyId: string }
  /** A Dispatch or its worker's start changed state. */
  | { kind: 'dispatch'; id: string }
  /** A paired computer answered a pull again: a notice it couldn't take before is sent again. */
  | { kind: 'reachable'; environmentId: string }

const listeners = new Set<(edge: QuestionEdge) => void>()

export function listenForQuestionEdges(listener: (edge: QuestionEdge) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function noteQuestionEdge(edge: QuestionEdge): void {
  if (listeners.size === 0) {
    return
  }
  queueMicrotask(() => {
    for (const listener of listeners) {
      try {
        listener(edge)
      } catch (error) {
        console.warn('[agent-questions] a question edge listener failed', error)
      }
    }
  })
}
