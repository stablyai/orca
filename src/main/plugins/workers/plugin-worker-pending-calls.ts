import type { PluginResponse } from '../../../shared/plugins/frames/plugin-protocol'

type PendingCall = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** Host → worker requests awaiting their `res`: each settles once, from its answer or its timeout. */
export function createPluginWorkerPendingCalls(tag: string, cancel: (id: number) => void) {
  const pending = new Map<number, PendingCall>()
  return {
    start(id: number, label: string, timeoutMs: number, send: () => void): Promise<unknown> {
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          // Tell the handler too, so it stops instead of running on unobserved.
          cancel(id)
          reject(new Error(`${tag} ${label} timed out after ${timeoutMs}ms`))
        }, timeoutMs)
        pending.set(id, { resolve, reject, timer })
        send()
      })
    },
    /** False when no call waits on this id (an event delivery, or one that timed out). */
    settle(response: PluginResponse): boolean {
      const entry = pending.get(response.id)
      if (!entry) {
        return false
      }
      clearTimeout(entry.timer)
      pending.delete(response.id)
      if (response.error) {
        entry.reject(new Error(response.error.message || 'plugin worker call failed'))
      } else {
        entry.resolve(response.result)
      }
      return true
    },
    rejectAll(reason: string): void {
      for (const [id, entry] of pending) {
        clearTimeout(entry.timer)
        pending.delete(id)
        entry.reject(new Error(reason))
      }
    },
    size: () => pending.size
  }
}
