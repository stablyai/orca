import { randomUUID } from 'node:crypto'
import {
  AI_VAULT_SCAN_CANCELLED_MESSAGE,
  type AiVaultListResult
} from '../../shared/ai-vault-types'

// Match the renderer throttle: forced requests share this window before they can preempt a hung scan.
const FORCED_SCAN_PREEMPT_AFTER_MS = 5_000

type ScanEntry = {
  id: string
  controller: AbortController
  force: boolean
  startedAt: number
  promise: Promise<AiVaultListResult>
  waiterCount: number
  settled: boolean
  // Preempted waiters join the replacement instead of surfacing another caller's cancellation.
  preemptedBy: ScanEntry | null
}

export class AiVaultScanCoordinator {
  private readonly entries = new Map<string, ScanEntry>()

  run(args: {
    key: string
    force?: boolean
    signal?: AbortSignal
    onCreate?: (id: string) => void
    onError?: (error: unknown) => void
    onReject?: (error: unknown, id: string) => unknown
    start: (signal: AbortSignal, id: string) => Promise<AiVaultListResult>
  }): Promise<AiVaultListResult> {
    if (args.signal?.aborted) {
      return Promise.reject(scanCancellationError())
    }
    let entry = this.entries.get(args.key)
    const preempted = entry && args.force === true && canPreemptForForcedScan(entry) ? entry : null
    if (preempted) {
      this.removeEntry(args.key, preempted)
      entry = undefined
    }
    if (!entry) {
      entry = this.createEntry(
        args.key,
        args.force === true,
        args.start,
        args.onCreate,
        args.onError
      )
      this.entries.set(args.key, entry)
    }
    if (preempted) {
      // Abort listeners rejoin synchronously, so register the replacement before aborting.
      preempted.preemptedBy = entry
      preempted.controller.abort()
    }
    return this.attach(args.key, entry, args.signal, args.onReject)
  }

  private createEntry(
    key: string,
    force: boolean,
    start: (signal: AbortSignal, id: string) => Promise<AiVaultListResult>,
    onCreate?: (id: string) => void,
    onError?: (error: unknown) => void
  ): ScanEntry {
    const controller = new AbortController()
    const id = randomUUID()
    onCreate?.(id)
    const entry: ScanEntry = {
      id,
      controller,
      force,
      startedAt: Date.now(),
      promise: Promise.resolve().then(() => {
        if (controller.signal.aborted) {
          throw scanCancellationError()
        }
        return start(controller.signal, id)
      }),
      waiterCount: 0,
      settled: false,
      preemptedBy: null
    }
    const onSettled = (): void => {
      entry.settled = true
      this.removeEntry(key, entry)
    }
    void entry.promise.then(onSettled, (error) => {
      onError?.(error)
      onSettled()
    })
    return entry
  }

  private attach(
    key: string,
    entry: ScanEntry,
    signal?: AbortSignal,
    onReject?: (error: unknown, id: string) => unknown
  ): Promise<AiVaultListResult> {
    entry.waiterCount++
    return new Promise((resolve, reject) => {
      let attached = true
      const detach = (): void => {
        if (!attached) {
          return
        }
        attached = false
        signal?.removeEventListener('abort', onAbort)
        entry.controller.signal.removeEventListener('abort', onAbort)
        entry.waiterCount--
        if (entry.waiterCount === 0 && !entry.settled && !entry.controller.signal.aborted) {
          this.removeEntry(key, entry)
          entry.controller.abort()
        }
      }
      const onAbort = (): void => {
        if (!attached) {
          return
        }
        // Other waiters did not cancel; a forced refresh transfers them to its replacement.
        const replacement = signal?.aborted ? null : entry.preemptedBy
        detach()
        if (!replacement) {
          reject(scanCancellationError())
          return
        }
        void this.attach(key, replacement, signal, onReject).then(resolve, reject)
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      entry.controller.signal.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted || entry.controller.signal.aborted) {
        onAbort()
        return
      }
      void entry.promise.then(
        (result) => {
          if (attached) {
            detach()
            resolve(result)
          }
        },
        (error) => {
          if (attached) {
            detach()
            reject(onReject ? onReject(error, entry.id) : error)
          }
        }
      )
    })
  }

  private removeEntry(key: string, entry: ScanEntry): void {
    if (this.entries.get(key) === entry) {
      this.entries.delete(key)
    }
  }
}

// Allow refresh to escape hung forced scans, including legacy SSH reads without inactivity timeouts (#11364).
function canPreemptForForcedScan(entry: ScanEntry): boolean {
  return !entry.force || Date.now() - entry.startedAt >= FORCED_SCAN_PREEMPT_AFTER_MS
}

function scanCancellationError(): Error {
  const error = new Error(AI_VAULT_SCAN_CANCELLED_MESSAGE)
  error.name = 'AbortError'
  return error
}
