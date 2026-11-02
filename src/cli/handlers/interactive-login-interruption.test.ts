import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  terminateInteractiveLoginProcess,
  terminateWindowsLoginProcessTree
} from './interactive-login-interruption'

function loginChild(pid = 4321): ChildProcess & EventEmitter {
  return Object.assign(new EventEmitter(), {
    kill: vi.fn(),
    pid
  }) as unknown as ChildProcess & EventEmitter
}

afterEach(() => {
  vi.useRealTimers()
})

describe('terminateInteractiveLoginProcess', () => {
  it('runs bounded taskkill /T /F without a shell', async () => {
    const execFileImpl = vi.fn(
      (
        _command: string,
        _args: readonly string[],
        _options: { timeout?: number; windowsHide?: boolean },
        callback: (error: Error | null) => void
      ) => callback(null)
    )

    await terminateWindowsLoginProcessTree(4321, execFileImpl as never)

    expect(execFileImpl).toHaveBeenCalledWith(
      'taskkill',
      ['/pid', '4321', '/T', '/F'],
      { timeout: 5_000, windowsHide: true },
      expect.any(Function)
    )
  })

  it('waits for both Windows tree termination and physical wrapper close', async () => {
    const child = loginChild()
    let finishTreeKill: (() => void) | undefined
    const killWindowsTree = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishTreeKill = resolve
        })
    )
    let terminated = false

    const pending = terminateInteractiveLoginProcess(child, 'SIGTERM', {
      platform: 'win32',
      killWindowsTree
    }).then(() => {
      terminated = true
    })

    expect(killWindowsTree).toHaveBeenCalledWith(4321)
    child.emit('close', 1)
    await Promise.resolve()
    expect(terminated).toBe(false)

    finishTreeKill?.()
    await pending
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('bounds Windows close waits and falls back to the direct wrapper', async () => {
    vi.useFakeTimers()
    const child = loginChild()

    let terminated = false
    const pending = terminateInteractiveLoginProcess(child, 'SIGINT', {
      platform: 'win32',
      killWindowsTree: vi.fn().mockResolvedValue(undefined)
    }).then(() => {
      terminated = true
    })
    await vi.advanceTimersByTimeAsync(999)
    expect(child.kill).not.toHaveBeenCalled()
    expect(terminated).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(child.kill).toHaveBeenCalledOnce()
    expect(child.kill).toHaveBeenCalledWith(undefined)

    await vi.advanceTimersByTimeAsync(999)
    expect(terminated).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await pending
    expect(terminated).toBe(true)
  })

  it('forwards the interrupt signal to a direct POSIX child and awaits close', async () => {
    const child = loginChild()
    let terminated = false

    const pending = terminateInteractiveLoginProcess(child, 'SIGHUP', {
      platform: 'linux'
    }).then(() => {
      terminated = true
    })

    expect(child.kill).toHaveBeenCalledWith('SIGHUP')
    await Promise.resolve()
    expect(terminated).toBe(false)

    child.emit('close', 1)
    await pending
    expect(child.kill).toHaveBeenCalledOnce()
  })

  it('force-kills an unresponsive POSIX child before the final bounded wait', async () => {
    vi.useFakeTimers()
    const child = loginChild()

    let terminated = false
    const pending = terminateInteractiveLoginProcess(child, 'SIGINT', {
      platform: 'darwin'
    }).then(() => {
      terminated = true
    })
    await vi.advanceTimersByTimeAsync(4_999)
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGINT')
    expect(terminated).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(child.kill).toHaveBeenNthCalledWith(1, 'SIGINT')
    expect(child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL')

    await vi.advanceTimersByTimeAsync(999)
    expect(terminated).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await pending
    expect(terminated).toBe(true)
  })
})
