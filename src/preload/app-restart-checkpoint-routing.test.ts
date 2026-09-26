import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PreloadApi } from './api-types'
import {
  ORCA_APP_RESTART_ABORTED_EVENT,
  ORCA_APP_RESTART_STARTED_EVENT
} from '../shared/updater-renderer-events'
import { KEYBOARD_LAYOUT_CHANGED_CHANNEL } from '../shared/keyboard-layout-events'

const { exposeInMainWorld, invoke, on, removeListener, send, sendSync } = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
  send: vi.fn(),
  sendSync: vi.fn()
}))

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld },
  ipcRenderer: { invoke, on, removeListener, send, sendSync },
  webFrame: {
    getZoomFactor: vi.fn(() => 1),
    setZoomFactor: vi.fn(),
    setVisualZoomLevelLimits: vi.fn()
  },
  webUtils: { getPathForFile: vi.fn(() => '') }
}))

describe('native preload destructive app actions', () => {
  const originalContextIsolated = Object.getOwnPropertyDescriptor(process, 'contextIsolated')
  let eventTarget: EventTarget

  beforeEach(() => {
    vi.resetModules()
    exposeInMainWorld.mockReset()
    invoke.mockReset()
    on.mockReset()
    removeListener.mockReset()
    send.mockReset()
    sendSync.mockReset()
    Object.defineProperty(process, 'contextIsolated', { configurable: true, value: true })
    eventTarget = new EventTarget()
    vi.stubGlobal('window', eventTarget)
    vi.stubGlobal('document', { addEventListener: vi.fn() })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    if (originalContextIsolated) {
      Object.defineProperty(process, 'contextIsolated', originalContextIsolated)
    } else {
      Reflect.deleteProperty(process, 'contextIsolated')
    }
  })

  const loadApi = async (): Promise<PreloadApi> => {
    await import('./index')
    return exposeInMainWorld.mock.calls.find(([name]) => name === 'api')?.[1] as PreloadApi
  }

  for (const action of ['reload', 'relaunch'] as const) {
    it(`prepares and awaits durability before ${action}`, async () => {
      const api = await loadApi()
      const calls: string[] = []
      eventTarget.addEventListener(ORCA_APP_RESTART_STARTED_EVENT, () => calls.push('prepared'))
      invoke.mockImplementation(async (channel: string) => {
        calls.push(channel)
        return channel === 'app:await-before-unload-checkpoint' ? { ok: true } : undefined
      })

      await api.app[action]()

      expect(calls).toEqual(['prepared', 'app:await-before-unload-checkpoint', `app:${action}`])
    })

    it(`refuses ${action} when the durable checkpoint fails`, async () => {
      const api = await loadApi()
      const aborted = vi.fn()
      eventTarget.addEventListener(ORCA_APP_RESTART_ABORTED_EVENT, aborted)
      invoke.mockImplementation(async (channel: string) =>
        channel === 'app:await-before-unload-checkpoint' ? { ok: false } : undefined
      )

      await expect(api.app[action]()).rejects.toThrow(
        'Failed to persist renderer state before unload.'
      )

      expect(invoke).not.toHaveBeenCalledWith(`app:${action}`)
      expect(aborted).toHaveBeenCalledTimes(1)
    })
  }

  it('exposes the durable checkpoint join the lazy-chunk recovery reload depends on', async () => {
    const api = await loadApi()
    invoke.mockResolvedValue({ ok: true })

    await expect(api.app.awaitBeforeUnloadCheckpoint()).resolves.toBeUndefined()
    expect(invoke).toHaveBeenCalledWith('app:await-before-unload-checkpoint')

    invoke.mockResolvedValue({ ok: false })

    await expect(api.app.awaitBeforeUnloadCheckpoint()).rejects.toThrow(
      'Failed to persist renderer state before unload.'
    )
  })

  it('throws with the actual error when stageBeforeUnloadSync fails with error message', async () => {
    const api = await loadApi()
    sendSync.mockReturnValue({ ok: false, error: 'session write failed' })

    expect(() => api.app.stageBeforeUnloadSync({ sessions: [], ui: {} })).toThrow(
      'Failed to stage renderer state before unload: session write failed'
    )
    expect(sendSync).toHaveBeenCalledWith('app:stage-before-unload-sync', { sessions: [], ui: {} })
  })

  it('throws generic error when stageBeforeUnloadSync fails without error message', async () => {
    const api = await loadApi()
    sendSync.mockReturnValue({ ok: false })

    expect(() => api.app.stageBeforeUnloadSync({ sessions: [], ui: {} })).toThrow(
      'Failed to stage renderer state before unload.'
    )
  })

  it('preserves both macOS keyboard preload adapters', async () => {
    const api = await loadApi()
    invoke.mockResolvedValue(undefined)

    await api.app.getMacCapturedDigitRowChords()
    await api.app.getKeyboardLayoutSnapshot()
    const onKeyboardLayoutChanged = vi.fn()
    const unsubscribe = api.app.onKeyboardLayoutChanged(onKeyboardLayoutChanged)
    const listener = on.mock.calls.find(
      ([channel]) => channel === KEYBOARD_LAYOUT_CHANGED_CHANNEL
    )?.[1] as ((event: unknown, payload: unknown) => void) | undefined
    const payload = { phase: 'invalidated', generation: 1 }
    listener?.({}, payload)
    unsubscribe()

    expect(invoke).toHaveBeenCalledWith('app:getMacCapturedDigitRowChords')
    expect(invoke).toHaveBeenCalledWith('app:getKeyboardLayoutSnapshot')
    expect(onKeyboardLayoutChanged).toHaveBeenCalledExactlyOnceWith(payload)
    expect(removeListener).toHaveBeenCalledWith(KEYBOARD_LAYOUT_CHANGED_CHANNEL, listener)
  })

  it('awaits renderer durability before profile maintenance and preserves its result', async () => {
    const api = await loadApi()
    const started = vi.fn()
    eventTarget.addEventListener(ORCA_APP_RESTART_STARTED_EVENT, started)
    let finishCheckpoint = (_result: { ok: boolean }): void => {}
    const checkpoint = new Promise((resolve) => {
      finishCheckpoint = resolve
    })
    const result = { status: 'relaunching' }
    invoke.mockImplementation((channel: string) =>
      channel === 'app:await-before-unload-checkpoint' ? checkpoint : Promise.resolve(result)
    )

    const switching = api.orcaProfiles.switchProfile({ profileId: 'target' })
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('app:await-before-unload-checkpoint')
    )
    expect(started).toHaveBeenCalledOnce()
    expect(invoke).not.toHaveBeenCalledWith('orcaProfiles:switch', expect.anything())
    finishCheckpoint({ ok: true })
    await expect(switching).resolves.toBe(result)
    expect(invoke).toHaveBeenLastCalledWith('orcaProfiles:switch', { profileId: 'target' })
  })

  it.each(['checkpoint-failed', 'switch-failed', 'already-active'])(
    'resets restart preparation when profile switching returns %s',
    async (outcome) => {
      const api = await loadApi()
      const aborted = vi.fn()
      eventTarget.addEventListener(ORCA_APP_RESTART_ABORTED_EVENT, aborted)
      invoke.mockImplementation(async (channel: string) => {
        if (channel === 'app:await-before-unload-checkpoint') {
          return { ok: outcome !== 'checkpoint-failed' }
        }
        if (outcome === 'switch-failed') {
          throw new Error('switch failed')
        }
        return { status: 'already-active' }
      })
      const switching = api.orcaProfiles.switchProfile({ profileId: 'target' })
      await (outcome === 'already-active'
        ? expect(switching).resolves.toEqual({ status: 'already-active' })
        : expect(switching).rejects.toThrow())
      expect(aborted).toHaveBeenCalledOnce()
      if (outcome === 'checkpoint-failed') {
        expect(invoke).not.toHaveBeenCalledWith('orcaProfiles:switch', expect.anything())
      }
    }
  )

  it.each(['move', 'copy', 'inactive', 'duplicate', 'recovery'] as const)(
    'prepares only a potentially relaunching project transfer: %s',
    async (outcome) => {
      const api = await loadApi()
      const started = vi.fn()
      const aborted = vi.fn()
      eventTarget.addEventListener(ORCA_APP_RESTART_STARTED_EVENT, started)
      eventTarget.addEventListener(ORCA_APP_RESTART_ABORTED_EVENT, aborted)
      const args = {
        sourceProfileId: outcome === 'inactive' ? 'inactive' : 'active',
        targetProfileId: 'target',
        repoId: 'repo',
        mode: outcome === 'copy' ? ('copy' as const) : ('move' as const)
      }
      const result =
        outcome === 'duplicate'
          ? { status: 'duplicate-target' }
          : { status: 'transferred', willRelaunch: outcome === 'move' }
      invoke.mockImplementation(async (channel: string) => {
        if (channel === 'orcaProfiles:list') {
          return { activeProfileId: 'active' }
        }
        if (channel === 'app:await-before-unload-checkpoint') {
          return { ok: true }
        }
        if (outcome === 'recovery') {
          const listener = on.mock.calls.find(([name]) => name === 'app:restart-committed')?.[1]
          expect(listener).toBeTypeOf('function')
          listener()
          throw new Error('move requires recovery')
        }
        return result
      })

      const transfer = api.orcaProfiles.transferProject(args)
      await (outcome === 'recovery'
        ? expect(transfer).rejects.toThrow('move requires recovery')
        : expect(transfer).resolves.toBe(result))
      const needsPreparation = outcome !== 'copy' && outcome !== 'inactive'
      expect(started).toHaveBeenCalledTimes(needsPreparation ? 1 : 0)
      expect(aborted).toHaveBeenCalledTimes(outcome === 'duplicate' ? 1 : 0)
      expect(invoke).toHaveBeenLastCalledWith('orcaProfiles:transferProject', args)
    }
  )
})
