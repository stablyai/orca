import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { UpdateStatus } from '../shared/types'
import {
  createUpdaterQuitAbortRelay,
  prepareRendererForAppRestart
} from './renderer-restart-preparation'

describe('prepareRendererForAppRestart', () => {
  it('aborts when the dispatched shutdown checkpoint prevents unload', async () => {
    const eventTarget = new EventTarget()
    const started = vi.fn()
    const aborted = vi.fn()
    const checkpoint = vi.fn((event: Event) => event.preventDefault())
    eventTarget.addEventListener('restart-started', started)
    eventTarget.addEventListener('restart-aborted', aborted)
    eventTarget.addEventListener('beforeunload', checkpoint)

    await expect(
      prepareRendererForAppRestart(eventTarget, {
        startedEventName: 'restart-started',
        abortedEventName: 'restart-aborted'
      })
    ).rejects.toThrow('Renderer shutdown checkpoint was not completed.')

    expect(started).toHaveBeenCalledTimes(1)
    expect(checkpoint).toHaveBeenCalledTimes(1)
    expect(aborted).toHaveBeenCalledTimes(1)
  })
})

describe('createUpdaterQuitAbortRelay', () => {
  it('resets a prepared update restart when async updater status reports failure', () => {
    const eventTarget = new EventTarget()
    const aborted = vi.fn()
    eventTarget.addEventListener('update-restart-aborted', aborted)
    const relay = createUpdaterQuitAbortRelay(eventTarget, 'update-restart-aborted')
    relay.markPrepared()

    relay.handleStatus({ state: 'error', message: 'install failed' } satisfies UpdateStatus)
    relay.handleStatus({ state: 'error', message: 'duplicate failure' } satisfies UpdateStatus)

    expect(aborted).toHaveBeenCalledTimes(1)
  })

  it('ignores updater errors when no update restart was prepared', () => {
    const eventTarget = new EventTarget()
    const aborted = vi.fn()
    eventTarget.addEventListener('update-restart-aborted', aborted)
    const relay = createUpdaterQuitAbortRelay(eventTarget, 'update-restart-aborted')

    relay.handleStatus({ state: 'error', message: 'check failed' } satisfies UpdateStatus)

    expect(aborted).not.toHaveBeenCalled()
  })
})

describe('preload restart wiring', () => {
  const source = readFileSync(join(process.cwd(), 'src/preload/index.ts'), 'utf8')

  it('relays prevented unload and async updater failure IPC into renderer lifecycle events', () => {
    expect(source).toContain("ipcRenderer.on('updater:status'")
    expect(source).toContain('updaterQuitAbortRelay.handleStatus(status)')
    expect(source).toContain("ipcRenderer.on('window:unload-prevented'")
    expect(source).toContain(
      'window.dispatchEvent(new Event(ORCA_RENDERER_UNLOAD_PREVENTED_EVENT))'
    )
  })

  it('marks updater preparation before invoking main and aborts it on immediate IPC failure', () => {
    const start = source.indexOf('quitAndInstall: async (): Promise<void> => {')
    const end = source.indexOf('onStatus: (callback) => {', start)
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    const block = source.slice(start, end)
    const prepare = block.indexOf('await prepareRendererForAppRestart(window, {')
    const markPrepared = block.indexOf('updaterQuitAbortRelay.markPrepared()')
    const invoke = block.indexOf("ipcRenderer.invoke('updater:quitAndInstall')")
    const abort = block.indexOf('updaterQuitAbortRelay.abort()')

    expect(prepare).toBeGreaterThanOrEqual(0)
    expect(markPrepared).toBeGreaterThan(prepare)
    expect(invoke).toBeGreaterThan(markPrepared)
    expect(abort).toBeGreaterThan(invoke)
    expect(block).toMatch(
      /try \{\s*return await ipcRenderer\.invoke\('updater:quitAndInstall'\)\s*\} catch \(error\) \{\s*updaterQuitAbortRelay\.abort\(\)\s*throw error\s*\}/
    )
  })
})
