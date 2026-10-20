type PendingCall = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export type PluginWorkerCallOutcome = { ok: true; value: unknown } | { ok: false; error: string }

/** Request/response bookkeeping for one plugin worker: every command or task
 *  source call gets an id and a timeout, and settles once from its result. */
export type PluginWorkerPendingCalls = {
  start(label: string, timeoutMs: number, send: (callId: number) => void): Promise<unknown>
  /** False when the call already timed out or was rejected. */
  settle(callId: number, outcome: PluginWorkerCallOutcome): boolean
  rejectAll(reason: string): void
  size(): number
}

export function createPluginWorkerPendingCalls(tag: string): PluginWorkerPendingCalls {
  const pending = new Map<number, PendingCall>()
  let nextCallId = 0
  return {
    start(label, timeoutMs, send) {
      const callId = nextCallId++
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(callId)
          reject(new Error(`${tag} ${label} timed out after ${timeoutMs}ms`))
        }, timeoutMs)
        pending.set(callId, { resolve, reject, timer })
        send(callId)
      })
    },
    settle(callId, outcome) {
      const entry = pending.get(callId)
      if (!entry) {
        return false
      }
      clearTimeout(entry.timer)
      pending.delete(callId)
      if (outcome.ok) {
        entry.resolve(outcome.value)
      } else {
        entry.reject(new Error(outcome.error))
      }
      return true
    },
    rejectAll(reason) {
      for (const [callId, entry] of pending) {
        clearTimeout(entry.timer)
        pending.delete(callId)
        entry.reject(new Error(reason))
      }
    },
    size: () => pending.size
  }
}
