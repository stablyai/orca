import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    quit: vi.fn(),
    exit: vi.fn(),
    isPackaged: false
  }
}))

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('installDevParentWatchdog', () => {
  it('quits the dev app when the original parent pid disappears', async () => {
    const { app } = await import('electron')
    const {
      installDevParentWatchdog,
      isDevParentShutdownRequested,
      resetDevParentShutdownRequestForTests
    } = await import('./configure-process')

    vi.useFakeTimers()
    resetDevParentShutdownRequestForTests()
    vi.mocked(app.quit).mockClear()
    vi.mocked(app.exit).mockClear()

    let parentExists = true
    vi.spyOn(process, 'kill').mockImplementation(((
      pid: number,
      signal?: NodeJS.Signals | number
    ) => {
      if (signal === 0 && pid === 4242 && !parentExists) {
        const error = new Error('missing') as NodeJS.ErrnoException
        error.code = 'ESRCH'
        throw error
      }
      return true
    }) as typeof process.kill)

    const originalPpid = Object.getOwnPropertyDescriptor(process, 'ppid')
    Object.defineProperty(process, 'ppid', {
      configurable: true,
      get: () => 4242
    })

    try {
      installDevParentWatchdog(true)
      await vi.advanceTimersByTimeAsync(1000)
      expect(app.quit).not.toHaveBeenCalled()

      parentExists = false
      await vi.advanceTimersByTimeAsync(1000)
      expect(isDevParentShutdownRequested()).toBe(true)
      expect(app.quit).toHaveBeenCalledTimes(1)
      expect(app.exit).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(3000)
      expect(app.exit).toHaveBeenCalledWith(0)
    } finally {
      if (originalPpid) {
        Object.defineProperty(process, 'ppid', originalPpid)
      }
    }
  })
})
