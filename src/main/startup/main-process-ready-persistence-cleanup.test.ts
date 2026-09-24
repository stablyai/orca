import { beforeEach, describe, expect, it, vi } from 'vitest'

const { state, foundation, runtime, i18n, launch } = vi.hoisted(() => ({
  state: {
    store: { freezeWritesAsync: vi.fn(async () => {}) },
    mainProcessI18nReady: Promise.resolve()
  },
  foundation: vi.fn(async () => {}),
  runtime: vi.fn(async () => {}),
  i18n: vi.fn(async () => {}),
  launch: vi.fn(async () => {})
}))

vi.mock('./main-process-state', () => ({ mainProcessState: state }))
vi.mock('./main-process-ready-foundation', () => ({ initializeReadyFoundation: foundation }))
vi.mock('./main-process-ready-runtime', () => ({ initializeReadyRuntimeServices: runtime }))
vi.mock('./main-process-i18n-menu', () => ({ initializeMainProcessI18nAndMenu: i18n }))
vi.mock('./main-process-runtime-launch', () => ({ initializeMainProcessRuntimeLaunch: launch }))

import { initializeMainProcessReady } from './main-process-ready'

const options = {
  openMainWindow: (): never => {
    throw new Error('Unexpected window creation in startup cleanup test')
  },
  handleMacAppActivation: () => {}
}

beforeEach(() => vi.clearAllMocks())

describe('startup persistence lifetime', () => {
  it('awaits writer release after a later startup phase fails', async () => {
    const failure = new Error('runtime startup failed')
    runtime.mockRejectedValueOnce(failure)
    let release = () => {}
    state.store.freezeWritesAsync.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    const ready = initializeMainProcessReady(options)
    const rejected = expect(ready).rejects.toBe(failure)
    await vi.waitFor(() => expect(state.store.freezeWritesAsync).toHaveBeenCalledOnce())
    release()
    await rejected
    expect(launch).not.toHaveBeenCalled()
  })

  it('joins concurrent startup branches before closing their Store', async () => {
    const failure = new Error('translations failed')
    i18n.mockRejectedValueOnce(failure)
    let release = () => {}
    launch.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    const ready = initializeMainProcessReady(options)
    const rejected = expect(ready).rejects.toBe(failure)
    await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce())
    expect(state.store.freezeWritesAsync).not.toHaveBeenCalled()
    release()
    await rejected
    expect(state.store.freezeWritesAsync).toHaveBeenCalledOnce()
  })

  it('keeps the original startup failure when cleanup also fails', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failure = new Error('foundation failed')
    foundation.mockRejectedValueOnce(failure)
    state.store.freezeWritesAsync.mockRejectedValueOnce(new Error('close failed'))
    try {
      await expect(initializeMainProcessReady(options)).rejects.toBe(failure)
      expect(log).toHaveBeenCalledOnce()
    } finally {
      log.mockRestore()
    }
  })
})
