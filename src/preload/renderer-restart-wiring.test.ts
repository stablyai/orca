import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { ORCA_RENDERER_UNLOAD_PREVENTED_EVENT } from '../shared/renderer-shutdown-events'
import {
  ORCA_APP_RESTART_ABORTED_EVENT,
  ORCA_APP_RESTART_COMMITTED_EVENT,
  ORCA_APP_RESTART_STARTED_EVENT,
  ORCA_UPDATER_QUIT_AND_INSTALL_STARTED_EVENT
} from '../shared/updater-renderer-events'
import {
  prepareAndInvokeAppRestart,
  prepareAndInvokeUpdaterInstall,
  registerRendererRestartIpcRelays
} from './renderer-restart-wiring'

describe('renderer restart wiring', () => {
  it.each(['no-op', 'failure'] as const)(
    'keeps a committed restart prepared after a later %s',
    async (outcome) => {
      const eventTarget = new EventTarget()
      const aborted = vi.fn()
      const started = vi.fn()
      const checkpoint = vi.fn(async () => {})
      eventTarget.addEventListener(ORCA_APP_RESTART_ABORTED_EVENT, aborted)
      eventTarget.addEventListener(ORCA_APP_RESTART_STARTED_EVENT, started)
      await prepareAndInvokeAppRestart(
        eventTarget,
        async () => {
          eventTarget.dispatchEvent(new Event(ORCA_APP_RESTART_COMMITTED_EVENT))
          return true
        },
        checkpoint,
        Boolean
      )
      const subsequent = prepareAndInvokeAppRestart(
        eventTarget,
        async () => {
          if (outcome === 'failure') {
            throw new Error('already finalized')
          }
          return false
        },
        checkpoint,
        Boolean
      )
      await (outcome === 'failure'
        ? expect(subsequent).rejects.toThrow('already finalized')
        : expect(subsequent).resolves.toBe(false))
      expect(checkpoint).toHaveBeenCalledOnce()
      expect(started).toHaveBeenCalledOnce()
      expect(aborted).not.toHaveBeenCalled()
    }
  )

  it('refuses overlapping preparation without abandoning the accepted restart', async () => {
    const eventTarget = new EventTarget()
    const aborted = vi.fn()
    eventTarget.addEventListener(ORCA_APP_RESTART_ABORTED_EVENT, aborted)
    const checkpoint = Promise.withResolvers<void>()
    const invoke = vi.fn(async () => true)
    const first = prepareAndInvokeAppRestart(eventTarget, invoke, () => checkpoint.promise)
    const refused = vi.fn(async () => false)
    await expect(
      prepareAndInvokeAppRestart(eventTarget, refused, async () => {}, Boolean)
    ).rejects.toThrow('already in progress')
    expect(refused).not.toHaveBeenCalled()
    expect(aborted).not.toHaveBeenCalled()
    checkpoint.resolve()
    await expect(first).resolves.toBe(true)
    expect(invoke).toHaveBeenCalledOnce()
  })

  it('retains late commitment across an unrelated unload veto', async () => {
    const eventTarget = new EventTarget()
    const abandoned = vi.fn()
    eventTarget.addEventListener(ORCA_APP_RESTART_ABORTED_EVENT, abandoned)
    eventTarget.addEventListener(ORCA_RENDERER_UNLOAD_PREVENTED_EVENT, abandoned)
    const ipcRenderer = {
      on: vi.fn<Parameters<typeof registerRendererRestartIpcRelays>[0]['on']>()
    }
    registerRendererRestartIpcRelays(ipcRenderer, eventTarget, {
      handleStatus: vi.fn(),
      abort: vi.fn()
    })
    const checkpoint = vi.fn(async () => {})
    await prepareAndInvokeAppRestart(eventTarget, async () => true, checkpoint, Boolean)
    const sender = Object.assign(new EventEmitter(), {
      invoke: vi.fn(async () => {}),
      postMessage: vi.fn(),
      send: vi.fn(),
      sendSync: vi.fn(),
      sendToHost: vi.fn()
    })
    const emit = (channel: string) => {
      const listener = ipcRenderer.on.mock.calls.find(([name]) => name === channel)?.[1]
      expect(listener).toBeTypeOf('function')
      listener?.({ ports: [], sender, defaultPrevented: false, preventDefault: vi.fn() })
    }
    emit('app:restart-committed')
    await prepareAndInvokeAppRestart(eventTarget, async () => false, checkpoint, Boolean)
    expect(checkpoint).toHaveBeenCalledOnce()
    emit('window:unload-prevented')
    await prepareAndInvokeAppRestart(eventTarget, async () => true, checkpoint, Boolean)
    expect(checkpoint).toHaveBeenCalledOnce()
    expect(abandoned).not.toHaveBeenCalled()
  })

  it('releases preparation ownership and its listener after checkpoint failure', async () => {
    const eventTarget = new EventTarget()
    const add = vi.spyOn(eventTarget, 'addEventListener')
    const remove = vi.spyOn(eventTarget, 'removeEventListener')
    await expect(
      prepareAndInvokeAppRestart(
        eventTarget,
        async () => {},
        async () => {
          throw new Error('checkpoint failed')
        }
      )
    ).rejects.toThrow('checkpoint failed')
    await prepareAndInvokeAppRestart(
      eventTarget,
      async () => {},
      async () => {}
    )
    const added = add.mock.calls.filter(([name]) => name === ORCA_APP_RESTART_COMMITTED_EVENT)
    const removed = remove.mock.calls.filter(([name]) => name === ORCA_APP_RESTART_COMMITTED_EVENT)
    expect(added).toHaveLength(2)
    expect(removed).toEqual(added)
  })

  it('relays updater status, aborted installs, and prevented unload events', () => {
    const eventTarget = new EventTarget()
    const unloadPrevented = vi.fn()
    const restartAborted = vi.fn()
    const restartCommitted = vi.fn()
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
    eventTarget.addEventListener(ORCA_APP_RESTART_COMMITTED_EVENT, restartCommitted)

    registerRendererRestartIpcRelays(ipcRenderer, eventTarget, { handleStatus, abort })
    listeners.get('updater:status')?.({}, { state: 'error', message: 'install failed' })
    // Why: main abandons an install without any status when its verdict outlived the cycle.
    listeners.get('updater:quitAndInstallAborted')?.({})
    listeners.get('window:unload-prevented')?.({})
    listeners.get('app:restart-committed')?.({})

    expect(ipcRenderer.on).toHaveBeenCalledTimes(4)
    expect(handleStatus).toHaveBeenCalledWith({ state: 'error', message: 'install failed' })
    expect(abort).toHaveBeenCalledTimes(1)
    expect(unloadPrevented).toHaveBeenCalledTimes(1)
    expect(restartAborted).toHaveBeenCalledTimes(1)
    expect(restartCommitted).toHaveBeenCalledTimes(1)
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
