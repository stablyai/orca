import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { openPathMock, spawnProcessMock } = vi.hoisted(() => ({
  openPathMock: vi.fn(),
  spawnProcessMock: vi.fn()
}))

vi.mock('electron', () => ({ shell: { openPath: openPathMock } }))
vi.mock('../shared/child-process/run-process', () => ({ spawnProcess: spawnProcessMock }))

import {
  LINUX_OPEN_PATH_SETTLE_BOUND_MS,
  openPathWithSystemDefault
} from './system-default-open-path'

describe('openPathWithSystemDefault', () => {
  let platformDescriptor: PropertyDescriptor | undefined
  let child: EventEmitter & { unref: ReturnType<typeof vi.fn> }

  function setPlatform(value: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { configurable: true, value })
  }

  beforeEach(() => {
    vi.useFakeTimers()
    openPathMock.mockReset()
    openPathMock.mockReturnValue(new Promise<string>(() => {}))
    spawnProcessMock.mockReset()
    child = Object.assign(new EventEmitter(), { unref: vi.fn() })
    spawnProcessMock.mockReturnValue(child)
    platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    setPlatform('linux')
  })

  afterEach(() => {
    vi.useRealTimers()
    if (platformDescriptor) {
      Object.defineProperty(process, 'platform', platformDescriptor)
    }
  })

  it('returns an error while a Linux launcher is still pending at the bound', async () => {
    let settled: string | undefined
    void openPathWithSystemDefault('/tmp/file.txt').then((value) => {
      settled = value
    })

    await vi.advanceTimersByTimeAsync(LINUX_OPEN_PATH_SETTLE_BOUND_MS - 1)
    expect(settled).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toMatch(/not confirmed/)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reports success only after the Linux opener exits successfully', async () => {
    const target = '/tmp/file #percent% ü.txt'
    const opened = openPathWithSystemDefault(target)
    child.emit('exit', 0, null)

    await expect(opened).resolves.toBe('')
    expect(spawnProcessMock).toHaveBeenCalledWith({
      program: 'xdg-open',
      args: [target],
      cwd: '/tmp',
      env: expect.objectContaining({ MM_NOTTTY: '1' }),
      detached: true,
      stdio: 'ignore'
    })
    expect(child.unref).toHaveBeenCalledOnce()
    expect(openPathMock).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([1, 2, 3, 4, null])('reports Linux launcher exit %s as failure', async (code) => {
    const opened = openPathWithSystemDefault('/tmp/file.txt')
    child.emit('exit', code, code === null ? 'SIGTERM' : null)

    await expect(opened).resolves.not.toBe('')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('preserves a missing-launcher rejection and clears the bound', async () => {
    const opened = openPathWithSystemDefault('/tmp/file.txt')
    const unavailable = new Error('spawn xdg-open ENOENT')
    const rejected = expect(opened).rejects.toBe(unavailable)
    child.emit('error', unavailable)

    await rejected
    expect(vi.getTimerCount()).toBe(0)
  })

  it('preserves synchronous spawn failures', async () => {
    const unavailable = new Error('launcher unavailable')
    spawnProcessMock.mockImplementationOnce(() => {
      throw unavailable
    })

    await expect(openPathWithSystemDefault('/tmp/file.txt')).rejects.toBe(unavailable)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('handles a late launcher error without turning the timeout into success', async () => {
    const opened = openPathWithSystemDefault('/tmp/file.txt')
    await vi.advanceTimersByTimeAsync(LINUX_OPEN_PATH_SETTLE_BOUND_MS)
    await expect(opened).resolves.toMatch(/not confirmed/)
    child.emit('error', new Error('late launcher error'))
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['darwin', 'win32'] as const)(
    'returns the original Electron promise on %s',
    async (platform) => {
      setPlatform(platform)
      let finish: (value: string) => void = () => {}
      const original = new Promise<string>((resolve) => (finish = resolve))
      openPathMock.mockReturnValue(original)

      expect(openPathWithSystemDefault('/tmp/file.txt')).toBe(original)
      await vi.advanceTimersByTimeAsync(LINUX_OPEN_PATH_SETTLE_BOUND_MS * 10)
      finish('no default app')
      await expect(original).resolves.toBe('no default app')
      expect(spawnProcessMock).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    }
  )
})
