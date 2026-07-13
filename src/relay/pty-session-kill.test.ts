import { describe, expect, it, vi } from 'vitest'
import {
  killPosixPtySession,
  PTY_SESSION_COMMAND_TIMEOUT_MS,
  PTY_SESSION_VERIFY_TIMEOUT_MS
} from './pty-session-kill'

describe('killPosixPtySession', () => {
  it('targets the full POSIX session with a bounded argument list', async () => {
    const run = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce({ stdout: 'Z\n' })

    await expect(killPosixPtySession(4242, '/dev/pts/7', 'linux', run)).resolves.toBe(true)

    expect(run).toHaveBeenCalledWith('pkill', ['-KILL', '-s', '4242', '.*'], {
      timeout: PTY_SESSION_COMMAND_TIMEOUT_MS
    })
    expect(run).toHaveBeenCalledWith('/bin/ps', ['-s', '4242', '-o', 'stat='], {
      timeout: PTY_SESSION_VERIFY_TIMEOUT_MS
    })
  })

  it('targets Darwin forkpty jobs through their controlling TTY', async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '4242 1\n4243 4242\n4244 4243\n' })
      .mockResolvedValueOnce({ stdout: '4242 Z\n4243 Z\n4244 Z\n' })
    const killProcess = vi.fn()

    await expect(
      killPosixPtySession(4242, '/dev/ttys042', 'darwin', run, killProcess)
    ).resolves.toBe(true)

    expect(run).toHaveBeenCalledWith('/bin/ps', ['-t', 'ttys042', '-o', 'pid=', '-o', 'ppid='], {
      timeout: PTY_SESSION_COMMAND_TIMEOUT_MS
    })
    expect(killProcess.mock.calls).toEqual([
      [4244, 'SIGKILL'],
      [4243, 'SIGKILL'],
      [4242, 'SIGKILL']
    ])
    expect(run).toHaveBeenLastCalledWith(
      '/bin/ps',
      ['-t', 'ttys042', '-o', 'pid=', '-o', 'stat='],
      { timeout: PTY_SESSION_VERIFY_TIMEOUT_MS }
    )
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

  it('fails closed when Linux session members remain runnable after SIGKILL', async () => {
    const run = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce({ stdout: 'D\n' })

    await expect(killPosixPtySession(4242, '/dev/pts/7', 'linux', run)).resolves.toBe(false)
  })

  it('fails closed when Darwin signals do not remove the captured processes', async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '4242 1\n4243 4242\n' })
      .mockResolvedValueOnce({ stdout: '4242 S\n4243 S\n' })
    const killProcess = vi.fn()

    await expect(
      killPosixPtySession(4242, '/dev/ttys042', 'darwin', run, killProcess)
    ).resolves.toBe(false)
    expect(killProcess).toHaveBeenCalledTimes(2)
  })

  it('accepts an exact empty-process ps exit after signalling', async () => {
    const emptySelection = Object.assign(new Error('no processes'), { code: 1, stdout: '' })
    const run = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(emptySelection)

    await expect(killPosixPtySession(4242, '/dev/pts/7', 'linux', run)).resolves.toBe(true)
  })

  it('verifies an already-empty Linux session after pkill finds no match', async () => {
    const emptySelection = Object.assign(new Error('no processes'), { code: 1, stdout: '' })
    const run = vi.fn().mockRejectedValueOnce(emptySelection).mockRejectedValueOnce(emptySelection)

    await expect(killPosixPtySession(4242, '/dev/pts/7', 'linux', run)).resolves.toBe(true)
    expect(run).toHaveBeenCalledTimes(2)
  })
})
