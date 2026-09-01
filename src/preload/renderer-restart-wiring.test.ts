import { describe, expect, it, vi } from 'vitest'
import { ORCA_RENDERER_UNLOAD_PREVENTED_EVENT } from '../shared/renderer-shutdown-events'
import {
  ORCA_APP_RESTART_ABORTED_EVENT,
  ORCA_APP_RESTART_STARTED_EVENT,
  ORCA_UPDATER_QUIT_AND_INSTALL_STARTED_EVENT
} from '../shared/updater-renderer-events'
import {
  prepareAndInvokeProfileRestore,
  prepareAndInvokeUpdaterInstall,
  registerRendererRestartIpcRelays
} from './renderer-restart-wiring'

describe('renderer restart wiring', () => {
  it('relays updater status, aborted installs, and prevented unload events', () => {
    const eventTarget = new EventTarget()
    const unloadPrevented = vi.fn()
    const restartAborted = vi.fn()
    const handleStatus = vi.fn()
    const abort = vi.fn()
    const listeners = new Map<string, (...args: unknown[]) => void>()
    const ipcRenderer = {
      on: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
        listeners.set(channel, listener)
        return ipcRenderer
      })
    } as unknown as Parameters<typeof registerRendererRestartIpcRelays>[0]
    eventTarget.addEventListener(ORCA_RENDERER_UNLOAD_PREVENTED_EVENT, unloadPrevented)
    eventTarget.addEventListener(ORCA_APP_RESTART_ABORTED_EVENT, restartAborted)

    registerRendererRestartIpcRelays(ipcRenderer, eventTarget, { handleStatus, abort })
    listeners.get('updater:status')?.({}, { state: 'error', message: 'install failed' })
    // Why: main abandons an install without any status when its verdict outlived the cycle.
    listeners.get('updater:quitAndInstallAborted')?.({})
    listeners.get('window:unload-prevented')?.({})

    expect(ipcRenderer.on).toHaveBeenCalledTimes(3)
    expect(handleStatus).toHaveBeenCalledWith({ state: 'error', message: 'install failed' })
    expect(abort).toHaveBeenCalledTimes(1)
    expect(unloadPrevented).toHaveBeenCalledTimes(1)
    expect(restartAborted).toHaveBeenCalledTimes(1)
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

    await expect(
      prepareAndInvokeUpdaterInstall(eventTarget, relay, invoke, async () => {
        calls.push('checkpoint-flushed')
      })
    ).rejects.toThrow('IPC failed')

    expect(calls).toEqual(['prepared', 'checkpoint-flushed', 'marked', 'invoked', 'aborted'])
  })

  it('never installs the update when the shutdown checkpoint fails to persist', async () => {
    const eventTarget = new EventTarget()
    const invoke = vi.fn(() => Promise.resolve())
    const relay = { markPrepared: vi.fn(), abort: vi.fn() }

    await expect(
      prepareAndInvokeUpdaterInstall(eventTarget, relay, invoke, () =>
        Promise.reject(new Error('Failed to persist renderer state before unload.'))
      )
    ).rejects.toThrow('Failed to persist renderer state before unload.')

    expect(invoke).not.toHaveBeenCalled()
    expect(relay.markPrepared).not.toHaveBeenCalled()
  })
})

// A committed restore replaces the profile, freezes writes, and quits. If a
// renderer close guard vetoes that quit, the app keeps running with every write
// silently dropped — so the restore must announce the restart before it commits.
describe('prepare-downgrade profile restore', () => {
  function trace(eventTarget: EventTarget, calls: string[]): void {
    eventTarget.addEventListener(ORCA_APP_RESTART_STARTED_EVENT, () => calls.push('started'))
    eventTarget.addEventListener(ORCA_APP_RESTART_ABORTED_EVENT, () => calls.push('aborted'))
  }

  it('stands the close guards down before main replaces the profile', async () => {
    const eventTarget = new EventTarget()
    const calls: string[] = []
    trace(eventTarget, calls)

    const result = await prepareAndInvokeProfileRestore(
      eventTarget,
      async () => {
        calls.push('restored')
        return { ok: true as const }
      },
      async () => {
        calls.push('checkpoint-flushed')
      }
    )

    expect(result).toEqual({ ok: true })
    // No abort: the guards must stay down through the quit that follows.
    expect(calls).toEqual(['started', 'checkpoint-flushed', 'restored'])
  })

  it('re-arms the close guards when main refuses without throwing', async () => {
    const eventTarget = new EventTarget()
    const calls: string[] = []
    trace(eventTarget, calls)

    const result = await prepareAndInvokeProfileRestore(
      eventTarget,
      async () => ({ ok: false as const, error: 'The selected recovery point no longer exists.' }),
      async () => {}
    )

    expect(result.ok).toBe(false)
    expect(calls).toEqual(['started', 'aborted'])
  })

  it('never replaces the profile when the shutdown checkpoint fails to persist', async () => {
    const eventTarget = new EventTarget()
    const calls: string[] = []
    trace(eventTarget, calls)
    const invoke = vi.fn(() => Promise.resolve({ ok: true as const }))

    await expect(
      prepareAndInvokeProfileRestore(eventTarget, invoke, () =>
        Promise.reject(new Error('Failed to persist renderer state before unload.'))
      )
    ).rejects.toThrow('Failed to persist renderer state before unload.')

    expect(invoke).not.toHaveBeenCalled()
    expect(calls).toEqual(['started', 'aborted'])
  })
})
