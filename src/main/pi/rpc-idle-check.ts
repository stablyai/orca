import { piRpcIdle, piRpcStateSchema, type PiRpcState } from './rpc-protocol'

type IdleCheckDeps = {
  request: () => Promise<unknown>
  current: (revision: number) => boolean
  settled: (state: PiRpcState) => void
  failed: (error: Error) => void
}

/** Detached compaction and new input invalidate an older settled signal and its idle reply. */
export class PiRpcIdleCheck {
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()
  private ended = false
  constructor(private readonly deps: IdleCheckDeps) {}

  schedule(revision: number, attempt = 0): void {
    queueMicrotask(() => {
      if (this.ended || !this.deps.current(revision)) {
        return
      }
      void this.deps
        .request()
        .then((value) => {
          if (this.ended || !this.deps.current(revision)) {
            return
          }
          const state = piRpcStateSchema.parse(value)
          if (piRpcIdle(state)) {
            this.deps.settled(state)
          }
        })
        .catch((error: unknown) => {
          if (this.ended || !this.deps.current(revision)) {
            return
          }
          if (attempt >= 2) {
            this.deps.failed(error instanceof Error ? error : new Error(String(error)))
            return
          }
          const timer = setTimeout(() => {
            this.timers.delete(timer)
            this.schedule(revision, attempt + 1)
          }, 100)
          timer.unref()
          this.timers.add(timer)
        })
    })
  }

  dispose(): void {
    this.ended = true
    for (const timer of this.timers) {
      clearTimeout(timer)
    }
    this.timers.clear()
  }
}
