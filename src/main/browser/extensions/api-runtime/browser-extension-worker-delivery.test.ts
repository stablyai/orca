import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('./browser-extension-execution-authority', () => ({
  isBrowserExtensionExecutionLive: (execution: { controller: AbortController }) =>
    !execution.controller.signal.aborted
}))
const pages = vi.hoisted(() => ({ live: false, notify: (_profile: string) => {} }))
vi.mock('../profile-sessions/browser-extension-profile-demand', () => ({
  hasBrowserExtensionProfilePage: () => pages.live,
  onBrowserExtensionPageRetained: (listener: (profile: string) => void) => {
    pages.notify = listener
    return () => {
      pages.notify = () => {}
    }
  }
}))
import {
  acknowledgeBrowserExtensionWorkerDelivery,
  deliverBrowserExtensionWorkerInteraction
} from './browser-extension-worker-delivery'
import type { BrowserExtensionExecution } from './browser-extension-execution-authority'
import type { WorkerContext } from './browser-extension-contexts'

function interaction() {
  pages.live = false
  const serviceWorkers = new EventEmitter()
  const task = { end: vi.fn() }
  const worker = { versionId: 7, isDestroyed: () => false, startTask: () => task }
  const sent: { deliveryId?: string }[] = []
  const stream = {
    send: (event: { deliveryId?: string }) => {
      sent.push(event)
    },
    close: () => {}
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The delivery fixture supplies every execution/context field accessed by the production path.
  const context = { running: worker, stream } as unknown as WorkerContext
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The delivery fixture supplies every execution/context field accessed by the production path.
  const execution = {
    controller: new AbortController(),
    session: { serviceWorkers },
    host: { browserProfileId: 'work' }
  } as unknown as BrowserExtensionExecution
  const pending = deliverBrowserExtensionWorkerInteraction(execution, context, {
    namespace: 'notifications',
    event: 'onClicked',
    args: ['saved']
  })
  const id = sent[0].deliveryId!
  return { execution, context, task, pending, id, serviceWorkers }
}

afterEach(() => vi.useRealTimers())

it('retains void asynchronous notification work after receipt until a real page owns it', async () => {
  const run = interaction()
  let completed = false
  void run.pending.then(() => {
    completed = true
  })
  acknowledgeBrowserExtensionWorkerDelivery(run.execution, run.context, run.id)
  expect(run.task.end).toHaveBeenCalledOnce()
  await Promise.resolve()
  expect(completed).toBe(false)
  run.serviceWorkers.emit('running-status-changed', { versionId: 6, runningStatus: 'stopped' })
  await Promise.resolve()
  expect(completed).toBe(false)
  pages.live = true
  pages.notify('work')
  await run.pending
  expect(completed).toBe(true)
})

it('ends notification-only demand on its native stop without keeping its own idle alive', async () => {
  const run = interaction()
  acknowledgeBrowserExtensionWorkerDelivery(run.execution, run.context, run.id)
  run.serviceWorkers.emit('running-status-changed', { versionId: 7, runningStatus: 'stopped' })
  await expect(run.pending).resolves.toBeUndefined()
  expect(run.task.end).toHaveBeenCalledOnce()
})

it('refuses another execution or replaced stream receipt and reports missing delivery without replay', async () => {
  vi.useFakeTimers()
  const run = interaction()
  const verdict = expect(run.pending).rejects.toThrow('did not acknowledge')
  acknowledgeBrowserExtensionWorkerDelivery({ ...run.execution }, run.context, run.id)
  const stream = run.context.stream
  run.context.stream = { send: () => {}, close: () => {} }
  acknowledgeBrowserExtensionWorkerDelivery(run.execution, run.context, run.id)
  run.context.stream = stream
  expect(run.task.end).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(300_000)
  await verdict
  expect(run.task.end).toHaveBeenCalledOnce()
  acknowledgeBrowserExtensionWorkerDelivery(run.execution, run.context, run.id)
})

it('cancels delivery on retirement and cannot release a later interaction with an old receipt', async () => {
  const old = interaction()
  const rejected = expect(old.pending).rejects.toThrow('unloaded')
  old.execution.controller.abort()
  await rejected
  const next = interaction()
  acknowledgeBrowserExtensionWorkerDelivery(next.execution, next.context, old.id)
  expect(next.task.end).not.toHaveBeenCalled()
  const stopped = expect(next.pending).rejects.toThrow('before acknowledging')
  next.serviceWorkers.emit('running-status-changed', { versionId: 7, runningStatus: 'stopped' })
  await stopped
})
