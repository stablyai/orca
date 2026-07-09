import { beforeEach, describe, expect, it, vi } from 'vitest'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))

vi.mock('node:child_process', () => ({ spawn: spawnMock }))

import {
  forceKillWindowsProcessTree,
  requestWindowsProcessTreeExit,
  waitForWindowsProcessTreeForceKill
} from './windows-process-tree-kill'

function createChildStub(): {
  on: ReturnType<typeof vi.fn>
  once: ReturnType<typeof vi.fn>
  unref: ReturnType<typeof vi.fn>
  kill: ReturnType<typeof vi.fn>
  emit: (event: 'exit' | 'error') => void
} {
  const onceHandlers = new Map<string, () => void>()
  return {
    on: vi.fn(),
    once: vi.fn((event: string, cb: () => void) => {
      onceHandlers.set(event, cb)
      return undefined
    }),
    unref: vi.fn(),
    kill: vi.fn(),
    emit: (event) => onceHandlers.get(event)?.()
  }
}

describe('windows-process-tree-kill', () => {
  beforeEach(() => {
    spawnMock.mockReset()
    spawnMock.mockReturnValue(createChildStub())
  })

  it('asks the tree to close without /F on the graceful path', () => {
    requestWindowsProcessTreeExit(1234)
    expect(spawnMock).toHaveBeenCalledWith('taskkill', ['/pid', '1234', '/T'], {
      windowsHide: true,
      stdio: 'ignore'
    })
  })

  it('forces the tree with /F on the escalation path', () => {
    forceKillWindowsProcessTree(1234)
    expect(spawnMock).toHaveBeenCalledWith('taskkill', ['/pid', '1234', '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore'
    })
  })

  it('detaches from the taskkill child so quit is never blocked', () => {
    const child = createChildStub()
    spawnMock.mockReturnValue(child)
    requestWindowsProcessTreeExit(42)
    expect(child.unref).toHaveBeenCalled()
    expect(child.on).toHaveBeenCalledWith('error', expect.any(Function))
  })

  it('ignores invalid pids instead of spawning taskkill', () => {
    requestWindowsProcessTreeExit(0)
    requestWindowsProcessTreeExit(-1)
    requestWindowsProcessTreeExit(Number.NaN)
    forceKillWindowsProcessTree(0)
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('swallows spawn failures (taskkill missing)', () => {
    spawnMock.mockImplementation(() => {
      throw new Error('ENOENT')
    })
    expect(() => forceKillWindowsProcessTree(99)).not.toThrow()
  })

  it('waits for force taskkill to exit', async () => {
    const child = createChildStub()
    spawnMock.mockReturnValue(child)
    let settled = false
    const wait = waitForWindowsProcessTreeForceKill(99).then(() => {
      settled = true
    })

    await Promise.resolve()
    expect(settled).toBe(false)
    expect(spawnMock).toHaveBeenCalledWith('taskkill', ['/pid', '99', '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore'
    })

    child.emit('exit')
    await wait
    expect(settled).toBe(true)
  })

  it('bounds force taskkill waits', async () => {
    vi.useFakeTimers()
    try {
      const child = createChildStub()
      spawnMock.mockReturnValue(child)
      const wait = waitForWindowsProcessTreeForceKill(100, 50)
      await vi.advanceTimersByTimeAsync(50)
      await expect(wait).resolves.toBeUndefined()
      expect(child.kill).toHaveBeenCalled()
      expect(child.unref).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
