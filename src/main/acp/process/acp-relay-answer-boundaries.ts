import { jsonRpcAnswerId } from '../../provider-relay/relayed-json-rpc-lines'

export type AcpRelayAnswerBoundary = { at: number; start: number | null; numbered: boolean }

/** Tracks observed answer lines and post-answer updates for each outstanding prompt id. */
export class AcpRelayAnswerBoundaries {
  private readonly answers = new Map<number, AcpRelayAnswerBoundary>()
  private readonly watched = new Set<number>()

  watch(id: number): void {
    this.watched.add(id)
  }

  forget(id: number): void {
    this.watched.delete(id)
    this.answers.delete(id)
  }

  observeAnswer(seq: number, line: string, activePromptId: number | null): void {
    const answerId = jsonRpcAnswerId(line)
    if (
      typeof answerId === 'number' &&
      (answerId === activePromptId || this.watched.has(answerId))
    ) {
      this.answers.set(answerId, { at: seq, start: null, numbered: false })
    }
  }

  observeUpdate(seq: number, unnumbered: boolean): void {
    for (const boundary of this.answers.values()) {
      if (seq > boundary.at) {
        boundary.start ??= seq
        if (unnumbered) {
          boundary.numbered = true
        }
      }
    }
  }

  consume(targetId: number | null, keepOthers: boolean): AcpRelayAnswerBoundary | null {
    const boundary = targetId !== null ? (this.answers.get(targetId) ?? null) : null
    if (targetId !== null) {
      this.answers.delete(targetId)
      this.watched.delete(targetId)
    }
    if (!keepOthers) {
      this.answers.clear()
      this.watched.clear()
    }
    return boundary
  }
}
