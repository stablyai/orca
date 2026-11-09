import type { AiVaultSearchRequest } from '../../shared/ai-vault/search/ai-vault-search-types'
import type { SessionSearchHostScope } from './session-search-service'
import { SessionSearchWorkerClient } from './session-search-worker-client'
import type { SearchWorkerCommand, SearchWorkerResponse } from './session-search-worker-protocol'

/** Two fixed slots count retiring native readers against capacity until their exit. */
export class SessionSearchReaders {
  private readonly slots = Array.from(
    { length: 2 },
    (): {
      client: SessionSearchWorkerClient
      opened: number
      opening: Promise<void> | null
    } => ({
      client: new SessionSearchWorkerClient(),
      opened: -1,
      opening: null
    })
  )
  private closed = false
  constructor(
    private readonly path: string,
    private readonly cutoff: number | null
  ) {}
  query(request: AiVaultSearchRequest, scope?: SessionSearchHostScope, signal?: AbortSignal) {
    return this.execute({ op: 'query', request, scope }, signal)
  }
  private execute(
    command: SearchWorkerCommand,
    signal?: AbortSignal
  ): Promise<SearchWorkerResponse> {
    const slot =
      this.slots.find((s) => !s.client.retiring && !s.client.busy) ??
      this.slots.find((s) => !s.client.retiring)
    if (this.closed || signal?.aborted || !slot) {
      return Promise.reject(new Error('Could not search sessions'))
    }
    return new Promise((resolve, reject) => {
      let finished = false
      const finish = (error?: unknown, value?: SearchWorkerResponse) => {
        if (finished) {
          return
        }
        finished = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        if (error || !value) {
          reject(error ?? new Error('Could not search sessions'))
        } else {
          resolve(value)
        }
      }
      const abort = () => {
        // Why: send failure before termination; a native SQLite call can delay worker exit.
        finish(new Error('Could not search sessions'))
        slot.client.stop()
      }
      const timer = setTimeout(abort, 10_000)
      signal?.addEventListener('abort', abort, { once: true })
      void (async () => {
        if (slot.opened !== slot.client.epoch) {
          slot.opening ??= (async () => {
            const epoch = slot.client.epoch
            await slot.client.request({
              op: 'open',
              path: this.path,
              reader: true,
              cutoff: this.cutoff
            })
            if (slot.client.epoch !== epoch) {
              throw new Error('Could not search sessions')
            }
            slot.opened = epoch
          })().finally(() => {
            slot.opening = null
          })
          await slot.opening
        }
        if (!finished) {
          finish(undefined, await slot.client.request(command))
        }
      })().catch((error) => finish(error))
    })
  }
  close(): Promise<void> {
    this.closed = true
    for (const slot of this.slots) {
      slot.client.stop()
    }
    return Promise.all(this.slots.map((s) => s.client.retired())).then(() => undefined)
  }
}
