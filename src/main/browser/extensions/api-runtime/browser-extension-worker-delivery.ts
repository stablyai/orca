import { randomUUID } from 'node:crypto'
import type { BrowserExtensionEventPayload } from '../../../../shared/browser/extensions/browser-extension-channels'
import type { WorkerContext } from './browser-extension-contexts'
import {
  isBrowserExtensionExecutionLive,
  type BrowserExtensionExecution
} from './browser-extension-execution-authority'
import {
  hasBrowserExtensionProfilePage,
  onBrowserExtensionPageRetained
} from '../profile-sessions/browser-extension-profile-demand'

// Chromium's default external-event request timeout; this bounds missing receipt, not worker age.
const DELIVERY_TIMEOUT_MS = 5 * 60 * 1000
const deliveries = new Map<
  string,
  {
    execution: BrowserExtensionExecution
    context: WorkerContext
    stream: WorkerContext['stream']
    worker: Electron.ServiceWorkerMain
    accept: () => void
  }
>()

export function acknowledgeBrowserExtensionWorkerDelivery(
  execution: BrowserExtensionExecution,
  context: WorkerContext,
  id: string
): void {
  const delivery = deliveries.get(id)
  if (
    delivery &&
    delivery.execution === execution &&
    delivery.context === context &&
    context.stream === delivery.stream &&
    context.running === delivery.worker &&
    !delivery.worker.isDestroyed() &&
    isBrowserExtensionExecutionLive(execution)
  ) {
    delivery.accept()
  }
}

/** Receipt ends the native task; only native stop or an actual page ends notification ownership. */
export function deliverBrowserExtensionWorkerInteraction(
  execution: BrowserExtensionExecution,
  context: WorkerContext,
  payload: BrowserExtensionEventPayload
): Promise<void> {
  const worker = context.running
  const stream = context.stream
  if (!worker || worker.isDestroyed() || !stream || !isBrowserExtensionExecutionLive(execution)) {
    return Promise.reject(new Error('Extension worker is unavailable'))
  }
  const id = randomUUID()
  const profileId = execution.host.browserProfileId
  const session = execution.session
  return new Promise<void>((resolve, reject) => {
    let received = false
    let settled = false
    let task: Electron.StartTask | null = null
    let timer: NodeJS.Timeout | undefined
    let removePageObserver = (): void => {}
    const endTask = (): void => {
      const ending = task
      task = null
      try {
        ending?.end()
      } catch {
        /* The captured worker has stopped. */
      }
    }
    const finish = (error?: Error): void => {
      if (settled) {
        return
      }
      settled = true
      deliveries.delete(id)
      clearTimeout(timer)
      endTask()
      removePageObserver()
      session.serviceWorkers.removeListener('running-status-changed', stopped)
      execution.controller.signal.removeEventListener('abort', cancelled)
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    }
    const cancelled = (): void => finish(new Error('Extension context was unloaded'))
    const stopped = ({
      versionId,
      runningStatus
    }: Electron.ServiceWorkersRunningStatusChangedEventParams): void => {
      if (versionId === worker.versionId && runningStatus === 'stopped') {
        finish(
          received ? undefined : new Error('Extension worker stopped before acknowledging delivery')
        )
      }
    }
    session.serviceWorkers.on('running-status-changed', stopped)
    execution.controller.signal.addEventListener('abort', cancelled, { once: true })
    removePageObserver = onBrowserExtensionPageRetained((retained) => {
      if (retained === profileId && received) {
        finish()
      }
    })
    deliveries.set(id, {
      execution,
      context,
      stream,
      worker,
      accept: () => {
        if (received || settled) {
          return
        }
        received = true
        deliveries.delete(id)
        clearTimeout(timer)
        endTask()
        if (hasBrowserExtensionProfilePage(profileId)) {
          finish()
        }
      }
    })
    try {
      execution.controller.signal.throwIfAborted()
      task = worker.startTask()
      timer = setTimeout(
        () => finish(new Error('Extension worker did not acknowledge delivery')),
        DELIVERY_TIMEOUT_MS
      )
      stream.send({ ...payload, deliveryId: id })
    } catch (error) {
      finish(error instanceof Error ? error : new Error('Extension event delivery failed'))
    }
  })
}
