import { randomUUID } from 'node:crypto'

export class WorkspaceViewRelay {
  private readonly pending = new Map<
    string,
    {
      rendererId: number
      resolve: (result: unknown) => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()

  request(
    rendererId: number,
    send: (id: string, operation: string, payload: unknown) => void,
    operation: string,
    payload: unknown
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = randomUUID()
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('View transfer timed out'))
      }, 15_000)
      this.pending.set(id, { rendererId, resolve, reject, timer })
      try {
        send(id, operation, payload)
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  reply(rendererId: number, id: string, result: unknown): boolean {
    const pending = this.pending.get(id)
    if (!pending || pending.rendererId !== rendererId) {
      return false
    }
    clearTimeout(pending.timer)
    this.pending.delete(id)
    pending.resolve(result)
    return true
  }

  disconnect(rendererId: number): void {
    for (const [id, pending] of this.pending) {
      if (pending.rendererId !== rendererId) {
        continue
      }
      clearTimeout(pending.timer)
      this.pending.delete(id)
      pending.reject(new Error('Destination closed'))
    }
  }
}
