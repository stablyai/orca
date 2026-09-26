import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { RuntimeNotifier } from '../runtime/runtime-notifier-contract'
import { registerRuntimeWindowLifecycle } from './runtime-window-lifecycle'

vi.mock('electron', () => ({ ipcMain: new EventEmitter() }))

function windowFixture(id: number) {
  const window = new EventEmitter()
  const webContents = new EventEmitter()
  const send = vi.fn()
  Object.assign(webContents, { isDestroyed: () => false, send })
  Object.assign(window, { id, isDestroyed: () => false, webContents })
  return { window: window as BrowserWindow, webContents, send }
}

it('accepted publication resumes only the matching window notifier and never a closed sender', () => {
  const runtime = new OrcaRuntimeService()
  const first = windowFixture(1)
  registerRuntimeWindowLifecycle(first.window, runtime)
  const graph = { tabs: [], leaves: [], rendererGeneration: 'first' }
  runtime.syncWindowGraph(1, graph)
  const internals = runtime as unknown as { notifier: RuntimeNotifier }
  first.send.mockImplementationOnce(() => {
    throw new Error('frame unavailable')
  })
  internals.notifier.reposChanged()
  expect(runtime.getStatus().graphStatus).toBe('unavailable')
  runtime.syncWindowGraph(1, graph)
  internals.notifier.reposChanged()
  expect(first.send).toHaveBeenCalledTimes(2)

  const oldNotifier = internals.notifier
  first.window.emit('closed')
  const second = windowFixture(2)
  registerRuntimeWindowLifecycle(second.window, runtime)
  runtime.syncWindowGraph(2, { ...graph, rendererGeneration: 'second' })
  oldNotifier.graphPublicationAccepted?.(1)
  oldNotifier.reposChanged()
  expect(first.send).toHaveBeenCalledTimes(2)
  internals.notifier.reposChanged()
  expect(second.send).toHaveBeenCalledOnce()
  second.window.emit('closed')
})
