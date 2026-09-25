/**
 * Pairs a host→worker request with the worker's reply: one call-id space, one
 * timeout policy, and one place that rejects everything still outstanding when
 * the worker dies. Commands and task sources each own a tracker, so their call
 * ids never collide and neither can settle the other's promise.
 */

import type { z } from 'zod'
import type {
  pluginWorkerCommandResultSchema,
  pluginWorkerTaskSourceResultSchema
} from '../../shared/plugins/plugin-host-protocol'

type PendingCall = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

// Distributes over the union so a field added to either protocol schema shows
// up here instead of being silently dropped.
type WithoutMessageType<T> = T extends unknown ? Omit<T, 'type'> : never

export type PluginWorkerCallReply = WithoutMessageType<
  | z.infer<typeof pluginWorkerCommandResultSchema>
  | z.infer<typeof pluginWorkerTaskSourceResultSchema>
>

export type PluginWorkerCallTrackerOptions = {
  /** Prefixes timeout and teardown messages, e.g. `[plugin:acme.demo]`. */
  tag: string
  timeoutMs: number
  failureMessage: string
  onSettled: () => void
}

export type PluginWorkerCallTracker = {
  /** `send` receives the allocated call id and must put the request on the
   *  wire; the promise settles on the matching reply or the timeout. */
  start(label: string, send: (callId: number) => void): Promise<unknown>
  settle(reply: PluginWorkerCallReply): void
  rejectAll(reason: string): void
  size(): number
}

export function createPluginWorkerCallTracker(
  options: PluginWorkerCallTrackerOptions
): PluginWorkerCallTracker {
  const pending = new Map<number, PendingCall>()
  let nextCallId = 0

  return {
    start(label, send) {
      const callId = nextCallId++
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(callId)
          reject(new Error(`${options.tag} ${label} timed out after ${options.timeoutMs}ms`))
        }, options.timeoutMs)
        pending.set(callId, { resolve, reject, timer })
        send(callId)
      })
    },
    settle(reply) {
      const entry = pending.get(reply.callId)
      if (!entry) {
        return
      }
      clearTimeout(entry.timer)
      pending.delete(reply.callId)
      options.onSettled()
      if (reply.ok) {
        entry.resolve(reply.value)
      } else {
        entry.reject(new Error(reply.error ?? options.failureMessage))
      }
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
