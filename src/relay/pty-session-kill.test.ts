import { describe, expect, it, vi } from 'vitest'
import { killPosixPtySession } from './pty-session-kill'

describe('killPosixPtySession', () => {
  it('targets the full POSIX session with a bounded argument list', async () => {
    const run = vi.fn().mockResolvedValue(undefined)

    await expect(killPosixPtySession(4242, '/dev/pts/7', 'linux', run)).resolves.toBe(true)

    expect(run).toHaveBeenCalledWith('pkill', ['-KILL', '-s', '4242', '.*'], {
      timeout: 3000
    })
  })

  it('targets Darwin forkpty jobs through their controlling TTY', async () => {
    const run = vi.fn().mockResolvedValue({ stdout: '4242 1\n4243 4242\n4244 4243\n' })
    const killProcess = vi.fn()

    await expect(
      killPosixPtySession(4242, '/dev/ttys042', 'darwin', run, killProcess)
    ).resolves.toBe(true)

    expect(run).toHaveBeenCalledWith('/bin/ps', ['-t', 'ttys042', '-o', 'pid=', '-o', 'ppid='], {
      timeout: 3000
    })
    expect(killProcess.mock.calls).toEqual([
      [4244, 'SIGKILL'],
      [4243, 'SIGKILL'],
      [4242, 'SIGKILL']
    ])
  })

  it('leaves Windows ConPTY teardown to node-pty', async () => {
    const run = vi.fn()

    await expect(killPosixPtySession(4242, undefined, 'win32', run)).resolves.toBe(false)
    expect(run).not.toHaveBeenCalled()
  })

  it('falls back cleanly when pkill is unavailable', async () => {
    const run = vi.fn().mockRejectedValue(new Error('pkill failed'))

    await expect(killPosixPtySession(4242, '/dev/ttys042', 'darwin', run)).resolves.toBe(false)
  })

  it('rejects an absent or ambiguous Darwin PTY name', async () => {
    const run = vi.fn()

    await expect(killPosixPtySession(4242, '/dev/ttys1,ttys2', 'darwin', run)).resolves.toBe(false)
    expect(run).not.toHaveBeenCalled()
  })

  it('does not signal a Darwin TTY that no longer owns the root pid', async () => {
    const run = vi.fn().mockResolvedValue({ stdout: '9999 1\n' })
    const killProcess = vi.fn()

    await expect(
      killPosixPtySession(4242, '/dev/ttys042', 'darwin', run, killProcess)
    ).resolves.toBe(false)
    expect(killProcess).not.toHaveBeenCalled()
  })
})
