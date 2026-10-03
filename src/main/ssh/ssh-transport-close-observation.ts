import type { EventEmitter } from 'node:events'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'

/** Register before initiating close; 'end', 'error' and destroy requests are not closure. */
export function observeSshTransportClose(resources: readonly EventEmitter[]) {
  const listeners: { resource: EventEmitter; close: () => void }[] = []
  const closed = Promise.all(
    resources.map(
      (resource) =>
        new Promise<void>((resolve) => {
          const close = () => resolve()
          listeners.push({ resource, close })
          resource.once('close', close)
        })
    )
  )
  return {
    wait: (signal: AbortSignal) => waitForPromiseWithSignal(closed, signal),
    dispose: () => {
      for (const { resource, close } of listeners) {
        resource.removeListener('close', close)
      }
    }
  }
}
