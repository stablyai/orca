import { describe, expect, it, vi } from 'vitest'
import { ORCA_RENDERER_UNLOAD_PREVENTED_EVENT } from '../shared/renderer-shutdown-events'
import { ORCA_UPDATER_QUIT_AND_INSTALL_STARTED_EVENT } from '../shared/updater-renderer-events'
import {
  prepareAndInvokeUpdaterInstall,
  registerRendererRestartIpcRelays
} from './renderer-restart-wiring'

describe('renderer restart wiring', () => {
  it('relays updater status and prevented unload events', () => {
    const eventTarget = new EventTarget()
    const unloadPrevented = vi.fn()
    const handleStatus = vi.fn()
    const listeners = new Map<string, (...args: unknown[]) => void>()
    const ipcRenderer = {
      on: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
        listeners.set(channel, listener)
        return ipcRenderer
      })
    } as unknown as Parameters<typeof registerRendererRestartIpcRelays>[0]
    eventTarget.addEventListener(ORCA_RENDERER_UNLOAD_PREVENTED_EVENT, unloadPrevented)

    registerRendererRestartIpcRelays(ipcRenderer, eventTarget, { handleStatus })
    listeners.get('updater:status')?.({}, { state: 'error', message: 'install failed' })
    listeners.get('window:unload-prevented')?.({})

    expect(ipcRenderer.on).toHaveBeenCalledTimes(2)
    expect(handleStatus).toHaveBeenCalledWith({ state: 'error', message: 'install failed' })
    expect(unloadPrevented).toHaveBeenCalledTimes(1)
  })

  it('marks preparation before invoking main and aborts on IPC failure', async () => {
    const eventTarget = new EventTarget()
    const calls: string[] = []
    eventTarget.addEventListener(ORCA_UPDATER_QUIT_AND_INSTALL_STARTED_EVENT, () => {
      calls.push('prepared')
    })
    const relay = {
      markPrepared: () => calls.push('marked'),
      abort: () => calls.push('aborted')
    }
    const invoke = vi.fn(async () => {
      calls.push('invoked')
      throw new Error('IPC failed')
    })

    await expect(prepareAndInvokeUpdaterInstall(eventTarget, relay, invoke)).rejects.toThrow(
      'IPC failed'
    )

    expect(calls).toEqual(['prepared', 'marked', 'invoked', 'aborted'])
  })
})
