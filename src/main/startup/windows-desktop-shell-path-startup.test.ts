import { describe, expect, it, vi } from 'vitest'
import { startWindowsDesktopBeforeShellPathReady } from './windows-desktop-shell-path-startup'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

describe('Windows desktop shell PATH startup', () => {
  it('opens the first window while shell PATH hydration remains unresolved', async () => {
    const shellPath = deferred()
    const window = { visible: true }
    const openWindow = vi.fn(() => window)
    const startServices = vi.fn(() => ({
      firstWindowReady: Promise.resolve(),
      localPtyReady: Promise.resolve(),
      localPtyProviderReady: Promise.resolve()
    }))

    const startup = startWindowsDesktopBeforeShellPathReady({
      openWindow,
      shellPathReady: shellPath.promise,
      startServices
    })

    expect(startup.window).toBe(window)
    expect(openWindow).toHaveBeenCalledOnce()
    expect(startServices).not.toHaveBeenCalled()

    shellPath.resolve()
    await startup.services
    expect(startServices).toHaveBeenCalledOnce()
  })
})
