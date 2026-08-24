import { describe, expect, it, vi } from 'vitest'
import {
  APP_RELAUNCH_PREPARE_ABORT_CHANNEL,
  APP_RELAUNCH_PREPARE_CHANNEL,
  APP_RELAUNCH_PREPARE_REPLY_CHANNEL
} from '../shared/relaunch-preparation-ipc'
import { ORCA_RENDERER_UNLOAD_PREVENTED_EVENT } from '../shared/renderer-shutdown-events'
import {
  ORCA_APP_RESTART_ABORTED_EVENT,
  ORCA_APP_RESTART_STARTED_EVENT,
  ORCA_UPDATER_QUIT_AND_INSTALL_STARTED_EVENT
} from '../shared/updater-renderer-events'
import {
  prepareAndInvokeUpdaterInstall,
  registerRelaunchPreparationRequestHandler,
  registerRendererRestartIpcRelays
} from './renderer-restart-wiring'

function createPreparationHarness(): {
  eventTarget: EventTarget
  listeners: Map<string, (...args: unknown[]) => void>
  sent: [string, unknown][]
  register: (awaitCheckpoint: () => Promise<void>) => void
} {
  const eventTarget = new EventTarget()
  const listeners = new Map<string, (...args: unknown[]) => void>()
  const sent: [string, unknown][] = []
  const ipcRenderer = {
    on: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
      listeners.set(channel, listener)
      return ipcRenderer
    }),
    send: vi.fn((channel: string, payload: unknown) => {
      sent.push([channel, payload])
    })
  } as unknown as Parameters<typeof registerRelaunchPreparationRequestHandler>[0]
  return {
    eventTarget,
    listeners,
    sent,
    register: (awaitCheckpoint) =>
      registerRelaunchPreparationRequestHandler(ipcRenderer, eventTarget, awaitCheckpoint)
  }
}

const flushMicrotasks = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

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

  it('prepares this window and confirms a main-driven relaunch preparation request', async () => {
    const { eventTarget, listeners, sent, register } = createPreparationHarness()
    const order: string[] = []
    eventTarget.addEventListener(ORCA_APP_RESTART_STARTED_EVENT, () => order.push('started'))
    const awaitCheckpoint = vi.fn(async () => {
      order.push('checkpoint-joined')
    })
    register(awaitCheckpoint)

    listeners.get(APP_RELAUNCH_PREPARE_CHANNEL)?.({}, { requestId: 7 })
    await flushMicrotasks()

    expect(order).toEqual(['started', 'checkpoint-joined'])
    expect(sent).toEqual([[APP_RELAUNCH_PREPARE_REPLY_CHANNEL, { requestId: 7, ok: true }]])
  })

  it('reports a refused checkpoint so main keeps the app open', async () => {
    const { eventTarget, listeners, sent, register } = createPreparationHarness()
    const aborted = vi.fn()
    eventTarget.addEventListener(ORCA_APP_RESTART_ABORTED_EVENT, aborted)
    register(() => Promise.reject(new Error('Failed to persist renderer state before unload.')))

    listeners.get(APP_RELAUNCH_PREPARE_CHANNEL)?.({}, { requestId: 3 })
    await flushMicrotasks()

    expect(sent).toEqual([[APP_RELAUNCH_PREPARE_REPLY_CHANNEL, { requestId: 3, ok: false }]])
    // Why: prepareRendererForAppRestart releases the restart latch on failure.
    expect(aborted).toHaveBeenCalledTimes(1)
  })

  it('releases the restart latch when main aborts the relaunch after preparation', () => {
    const { eventTarget, listeners, register } = createPreparationHarness()
    const aborted = vi.fn()
    eventTarget.addEventListener(ORCA_APP_RESTART_ABORTED_EVENT, aborted)
    register(async () => {})

    listeners.get(APP_RELAUNCH_PREPARE_ABORT_CHANNEL)?.({})

    expect(aborted).toHaveBeenCalledTimes(1)
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
