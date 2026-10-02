import type { HarnessConversationDriver } from './driver'

export type ClaudeTurn = { resolve: () => void; reject: (error: Error) => void }
type AcceptSteer = Parameters<NonNullable<HarnessConversationDriver['steer']>>[3]
type PendingSteer = {
  originalTurn: ClaudeTurn
  accept: AcceptSteer
  resolve: () => void
  reject: (error: Error) => void
}

export class ClaudeSteerController {
  private readonly pending = new Map<string, PendingSteer>()

  constructor(private readonly turns: ClaudeTurn[]) {}

  waitForReplay(uuid: string, originalTurn: ClaudeTurn, accept: AcceptSteer): Promise<void> {
    return new Promise((resolve, reject) => {
      this.pending.set(uuid, { originalTurn, accept, resolve, reject })
    })
  }

  async observeReplay(uuid: string): Promise<boolean> {
    const pending = this.pending.get(uuid)
    if (!pending) {
      return false
    }
    this.pending.delete(uuid)
    let nextTurn: ClaudeTurn | null = null
    try {
      if (this.turns[0] === pending.originalTurn) {
        await pending.accept({ placement: 'current' })
      } else {
        let resolve = (): void => undefined
        let reject = (_error: Error): void => undefined
        const completion = new Promise<void>((onResolve, onReject) => {
          resolve = onResolve
          reject = onReject
        })
        nextTurn = { resolve, reject }
        this.turns.push(nextTurn)
        await pending.accept({ placement: 'next', completion })
      }
      pending.resolve()
    } catch {
      if (nextTurn) {
        const index = this.turns.indexOf(nextTurn)
        if (index !== -1) {
          this.turns.splice(index, 1)
        }
      }
      pending.reject(new Error('conversation_steer_uncertain'))
    }
    return true
  }

  rejectAll(): void {
    for (const pending of this.pending.values()) {
      pending.reject(new Error('conversation_steer_uncertain'))
    }
    this.pending.clear()
  }
}
