import type { AcpPendingResponse, AcpRequestOptions, AcpResponse } from './acp-response-settlement'

/**
 * A peer's outstanding calls by id. An agent kept running across an app restart already saw the
 * earlier app's ids, so this app's start above them and can wait on an earlier app's call.
 */
export class AcpPendingCalls {
  readonly pending = new Map<number, AcpPendingResponse>()
  private next = 1

  constructor(private readonly closedWith: () => Error | undefined) {}

  /** `onId`: told the id before the request is written. */
  nextId(onId?: (id: number) => void): number {
    const id = this.next++
    onId?.(id)
    return id
  }

  startAbove(floor: number): void {
    this.next = Math.max(this.next, floor + 1)
  }

  /** Waits for the answer to an earlier app's call by its id. */
  adoptEarlier<T>(id: number, method: string, settle: AcpRequestOptions<T>['settle']): Promise<T> {
    const closed = this.closedWith()
    if (closed) {
      return Promise.reject(closed)
    }
    return new Promise<T>((resolve, reject) => {
      const answer = (response: AcpResponse): void => {
        try {
          resolve(settle(response))
        } catch (error) {
          reject(error)
        }
      }
      const call = {
        method,
        resolve: (value: unknown) => answer({ value }),
        reject: (error: Error) => answer({ error })
      }
      this.pending.set(id, call)
    })
  }

  rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }
}
