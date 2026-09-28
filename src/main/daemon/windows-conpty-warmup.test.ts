import type { BunPtySpawnArgs } from './pty-subprocess/bun-pty-process-contract'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
  vi.clearAllMocks()
})

function makeFakePty() {
  let exitListener: (() => void) | null = null
  const dispose = vi.fn()
  const proc = {
    pid: 4321,
    kill: vi.fn(),
    onExit: vi.fn((listener: () => void) => {
      exitListener = listener
      return { dispose }
    })
  }
  return { proc, dispose, fireExit: () => exitListener?.() }
}

describe('warmWindowsConptyOnce', () => {
  it('is a no-op off Windows', async () => {
    restorePlatform = setPlatform('darwin')
    const spawnPty = vi.fn()

    warmWindowsConptyOnce(spawnPty)
    await flushImmediates()

    expect(spawnPty).not.toHaveBeenCalled()
  })

  it('spawns a short-lived cmd.exe with the bundled ConPTY on Windows', async () => {
    restorePlatform = setPlatform('win32')
    const { proc, fireExit, dispose } = makeFakePty()
    const spawnPty = vi.fn((_args: BunPtySpawnArgs) => proc)

    warmWindowsConptyOnce(spawnPty)
    await flushImmediates()

    expect(spawnPty).toHaveBeenCalledTimes(1)
    const options = vi.mocked(spawnPty).mock.calls[0][0]
    expect(String(options.file).toLowerCase()).toContain('cmd')
    expect(options.args).toEqual(['/d', '/c', 'exit', '0'])
    expect(options).toMatchObject({ windowsJobKillOnClose: true, cols: 2, rows: 1 })

    // A clean exit must not leave the kill timer to fire later.
    fireExit()
    expect(dispose).toHaveBeenCalledOnce()
    expect(proc.kill).not.toHaveBeenCalled()
  })

  it('kills the warm-up shell if it never exits', async () => {
    restorePlatform = setPlatform('win32')
    vi.useFakeTimers()
    try {
      const { proc } = makeFakePty()
      const spawnPty = vi.fn((_args: BunPtySpawnArgs) => proc)

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
    })

    expect(() => warmWindowsConptyOnce(spawnPty)).not.toThrow()
    await flushImmediates()
  })

  it('disposes an already-exited probe and clears its kill timer', async () => {
    restorePlatform = setPlatform('win32')
    vi.useFakeTimers()
    const dispose = vi.fn()
    const kill = vi.fn()
    try {
      warmWindowsConptyOnce(() => ({
        kill,
        onExit(listener) {
          listener({ exitCode: 0 })
          return { dispose }
        }
      }))
      await vi.runOnlyPendingTimersAsync()
      expect(dispose).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
      expect(kill).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
