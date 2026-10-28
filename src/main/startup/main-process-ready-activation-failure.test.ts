import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MainProcessRuntimeLaunchOptions } from './main-process-runtime-launch'

const phases = vi.hoisted(() => ({
  foundation: vi.fn<() => Promise<void>>(),
  runtimeServices: vi.fn<() => Promise<void>>(),
  menu: vi.fn<() => Promise<void>>(),
  launch: vi.fn<(options: MainProcessRuntimeLaunchOptions) => Promise<void>>()
}))

vi.mock('./main-process-ready-foundation', () => ({
  initializeReadyFoundation: phases.foundation
}))
vi.mock('./main-process-ready-runtime', () => ({
  initializeReadyRuntimeServices: phases.runtimeServices
}))
vi.mock('./main-process-i18n-menu', () => ({ initializeMainProcessI18nAndMenu: phases.menu }))
vi.mock('./main-process-runtime-launch', () => ({
  initializeMainProcessRuntimeLaunch: phases.launch
}))

const { initializeMainProcessReady } = await import('./main-process-ready')
const { mainProcessState: state } = await import('./main-process-state')
const { createServeDesktopActivationGate } = await import('./serve-desktop-activation')

const activateWindow = vi.fn()
const launchOptions: MainProcessRuntimeLaunchOptions = {
  openMainWindow: vi.fn<MainProcessRuntimeLaunchOptions['openMainWindow']>(),
  handleMacAppActivation: vi.fn()
}

describe('desktop activation after ready-phase failures', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    phases.foundation.mockResolvedValue(undefined)
    phases.runtimeServices.mockResolvedValue(undefined)
    phases.menu.mockResolvedValue(undefined)
    phases.launch.mockResolvedValue(undefined)
    state.isServeMode = false
    state.desktopActivationGate = createServeDesktopActivationGate({
      initialState: 'initializing',
      activateWindow
    })
  })

  afterEach(() => {
    state.desktopActivationGate = null
    state.isServeMode = false
  })

  it.each(['foundation', 'runtimeServices'] as const)(
    'disables desktop activation after %s fails',
    async (phase) => {
      const error = new Error(`${phase} failed`)
      phases[phase].mockRejectedValueOnce(error)
      state.desktopActivationGate?.requestActivation()

      await expect(initializeMainProcessReady(launchOptions)).rejects.toBe(error)

      expect(activateWindow).not.toHaveBeenCalled()
      expect(state.desktopActivationGate).toBeNull()
      expect(phases.launch).not.toHaveBeenCalled()
      state.desktopActivationGate?.requestActivation()
      expect(activateWindow).not.toHaveBeenCalled()
    }
  )

  it.each(['foundation', 'runtimeServices'] as const)(
    'disables serve promotion after %s fails',
    async (phase) => {
      const error = new Error(`${phase} failed`)
      phases[phase].mockRejectedValueOnce(error)
      state.isServeMode = true
      state.desktopActivationGate?.requestActivation()

      await expect(initializeMainProcessReady(launchOptions)).rejects.toBe(error)

      expect(state.desktopActivationGate).toBeNull()
      state.desktopActivationGate?.requestActivation()
      expect(activateWindow).not.toHaveBeenCalled()
      expect(phases.launch).not.toHaveBeenCalled()
    }
  )

  it('keeps activations held when menu failure leaves window creation still pending', async () => {
    const error = new Error('menu failed')
    let finishLaunch = (): void => {
      throw new Error('launch has not started')
    }
    phases.menu.mockRejectedValueOnce(error)
    phases.launch.mockImplementationOnce(
      (options) =>
        new Promise<void>((resolve) => {
          finishLaunch = () => {
            options.openMainWindow()
            resolve()
          }
        })
    )
    state.desktopActivationGate?.requestActivation()

    const ready = initializeMainProcessReady(launchOptions)
    const rejected = expect(ready).rejects.toBe(error)
    await vi.waitFor(() => expect(phases.launch).toHaveBeenCalledOnce())

    expect(state.desktopActivationGate?.getState()).toBe('initializing')
    expect(activateWindow).not.toHaveBeenCalled()
    expect(launchOptions.openMainWindow).not.toHaveBeenCalled()
    finishLaunch()
    expect(launchOptions.openMainWindow).toHaveBeenCalledTimes(1)
    expect(state.desktopActivationGate?.getState()).toBe('ready')
    expect(activateWindow).toHaveBeenCalledTimes(1)
    await rejected
    expect(state.desktopActivationGate).toBeNull()
  })

  it('does not replay pending activations when window creation throws', async () => {
    const error = new Error('window creation failed')
    vi.mocked(launchOptions.openMainWindow).mockImplementationOnce(() => {
      throw error
    })
    phases.launch.mockImplementationOnce(async (options) => {
      options.openMainWindow()
    })
    state.desktopActivationGate?.requestActivation()

    await expect(initializeMainProcessReady(launchOptions)).rejects.toBe(error)

    expect(state.desktopActivationGate).toBeNull()
    expect(activateWindow).not.toHaveBeenCalled()
    expect(launchOptions.openMainWindow).toHaveBeenCalledTimes(1)
  })
})
