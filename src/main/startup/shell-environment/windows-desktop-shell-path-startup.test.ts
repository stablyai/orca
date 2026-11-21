import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  startWindowsDesktopBeforeShellPathReady,
  type WindowsDesktopStartupServices
} from './windows-desktop-shell-path-startup'

const services: WindowsDesktopStartupServices = {
  firstWindowReady: Promise.resolve(),
  localPtyReady: Promise.resolve(),
  localPtyProviderReady: Promise.resolve()
}

describe('Windows desktop startup ordering', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts terminal services only after the first window loads', async () => {
    const startServices = vi.fn(() => services)
    let windowLoaded = (): void => {}
    startWindowsDesktopBeforeShellPathReady({
      bindServices: vi.fn(),
      openWindow: (onLoaded) => {
        windowLoaded = onLoaded
      },
      shellPathReady: Promise.resolve(),
      startServices
    })

    await vi.advanceTimersByTimeAsync(1_000)
    expect(startServices).not.toHaveBeenCalled()

    windowLoaded()
    await vi.advanceTimersByTimeAsync(0)
    expect(startServices).toHaveBeenCalledOnce()
  })

  it('starts terminal services when the first window never loads', async () => {
    const startServices = vi.fn(() => services)
    startWindowsDesktopBeforeShellPathReady({
      bindServices: vi.fn(),
      openWindow: () => {},
      shellPathReady: Promise.resolve(),
      startServices
    })

    await vi.advanceTimersByTimeAsync(4_000)
    expect(startServices).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(startServices).toHaveBeenCalledOnce()
  })
})
