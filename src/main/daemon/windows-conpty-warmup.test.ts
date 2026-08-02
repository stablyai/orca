import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as pty from 'node-pty'
import { warmWindowsConptyOnce } from './windows-conpty-warmup'

function setPlatform(platform: NodeJS.Platform): () => void {
  const original = process.platform
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  return () => Object.defineProperty(process, 'platform', { configurable: true, value: original })
}

function flushImmediates(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

let restorePlatform: (() => void) | null = null
afterEach(() => {
  restorePlatform?.()
  restorePlatform = null
  vi.restoreAllMocks()
})

function makeFakePty(): { proc: pty.IPty; fireExit: () => void } {
  let exitListener: (() => void) | null = null
  const proc = {
    pid: 4321,
    kill: vi.fn(),
    onExit: vi.fn((listener: () => void) => {
      exitListener = listener
      return { dispose: () => undefined }
    })
  } as unknown as pty.IPty
  return { proc, fireExit: () => exitListener?.() }
}

describe('warmWindowsConptyOnce', () => {
  it('is a no-op off Windows', async () => {
    restorePlatform = setPlatform('darwin')
    const spawnPty = vi.fn() as unknown as typeof pty.spawn

    warmWindowsConptyOnce(spawnPty)
    await flushImmediates()

    expect(spawnPty).not.toHaveBeenCalled()
  })

  it('spawns a short-lived cmd.exe with the bundled ConPTY on Windows', async () => {
    restorePlatform = setPlatform('win32')
    const { proc, fireExit } = makeFakePty()
    const spawnPty = vi.fn(() => proc) as unknown as typeof pty.spawn

    warmWindowsConptyOnce(spawnPty)
    await flushImmediates()

    expect(spawnPty).toHaveBeenCalledTimes(1)
    const [file, args, options] = vi.mocked(spawnPty).mock.calls[0]
    expect(String(file).toLowerCase()).toContain('cmd')
    expect(args).toEqual(['/c', 'exit'])
    expect(options).toMatchObject({ useConptyDll: true, cols: 2, rows: 1 })

    // A clean exit must not leave the kill timer to fire later.
    fireExit()
    expect(proc.kill).not.toHaveBeenCalled()
  })

  it('kills the warm-up shell if it never exits', async () => {
    restorePlatform = setPlatform('win32')
    vi.useFakeTimers()
    try {
      const { proc } = makeFakePty()
      const spawnPty = vi.fn(() => proc) as unknown as typeof pty.spawn

      warmWindowsConptyOnce(spawnPty)
      await vi.runOnlyPendingTimersAsync()
      vi.advanceTimersByTime(10_000)

      expect(proc.kill).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('swallows spawn failures', async () => {
    restorePlatform = setPlatform('win32')
    const spawnPty = vi.fn(() => {
      throw new Error('conpty unavailable')
    }) as unknown as typeof pty.spawn

    expect(() => warmWindowsConptyOnce(spawnPty)).not.toThrow()
    await flushImmediates()
  })
})
