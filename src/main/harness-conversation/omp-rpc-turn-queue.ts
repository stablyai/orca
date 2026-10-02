type Turn = { requestId: string; resolve: () => void; reject: (error: Error) => void }

export class OmpRpcTurnQueue {
  readonly turns: Turn[] = []

  create(requestId: string): { turn: Turn; completion: Promise<void> } {
    let resolve = (): void => undefined
    let reject = (_error: Error): void => undefined
    const completion = new Promise<void>((onResolve, onReject) => {
      resolve = onResolve
      reject = onReject
    })
    return { turn: { requestId, resolve, reject }, completion }
  }

  push(requestId: string): Promise<void> {
    const next = this.create(requestId)
    this.turns.push(next.turn)
    return next.completion
  }

  remove(turn: Turn): void {
    const index = this.turns.indexOf(turn)
    if (index !== -1) {
      this.turns.splice(index, 1)
      turn.resolve()
    }
  }

  complete(requestId?: string): void {
    const index = requestId
      ? this.turns.findIndex((turn) => turn.requestId === requestId)
      : this.turns.length
        ? 0
        : -1
    if (index >= 0) {
      this.turns.splice(index, 1)[0]!.resolve()
    }
  }

  fail(error: Error): void {
    for (const turn of this.turns.splice(0)) {
      turn.reject(error)
    }
  }
}
