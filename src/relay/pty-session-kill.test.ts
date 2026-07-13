import { describe, expect, it, vi } from 'vitest'
import {
  killPosixPtySession,
  PTY_SESSION_COMMAND_TIMEOUT_MS,
  PTY_SESSION_VERIFY_TIMEOUT_MS
} from './pty-session-kill'

function emptySelection(): Error & { code: number; stdout: string } {
  return Object.assign(new Error('no processes'), { code: 1, stdout: '' })
}

describe('killPosixPtySession', () => {
  it('freezes and kills a Linux descendant that escaped into a new session', async () => {
    const run = vi.fn(async (file: string, args: string[]) => {
      if (file === '/bin/ps' && args.includes('sid=')) {
        return { stdout: '4242 pts/7\n' }
      }
      if (file === '/usr/bin/pgrep') {
        const parents = new Set(args[1]?.split(','))
        if (parents.has('4242')) {
          return { stdout: '4243\n4244\n' }
        }
        if (parents.has('4244')) {
          return { stdout: '4245\n' }
        }
        throw emptySelection()
      }
      if (file === '/bin/ps' && args.some((arg) => arg.includes('4245'))) {
        return { stdout: '4242 Z\n4243 Z\n4244 Z\n4245 Z\n' }
      }
      throw new Error(`Unexpected command: ${file} ${args.join(' ')}`)
    })
    const killProcess = vi.fn()

    await expect(killPosixPtySession(4242, '/dev/pts/7', 'linux', run, killProcess)).resolves.toBe(
      true
    )

    expect(killProcess.mock.calls).toEqual([
      [4242, 'SIGSTOP'],
      [4243, 'SIGSTOP'],
      [4244, 'SIGSTOP'],
      [4245, 'SIGSTOP'],
      [4245, 'SIGKILL'],
      [4244, 'SIGKILL'],
      [4243, 'SIGKILL'],
      [4242, 'SIGKILL']
    ])
    expect(run).not.toHaveBeenCalledWith(
      '/bin/ps',
      expect.arrayContaining(['-e']),
      expect.anything()
    )
    expect(run.mock.calls.filter(([file]) => file === '/usr/bin/pgrep')).toHaveLength(3)
  })

  it('validates Darwin root ownership before targeted descendant teardown', async () => {
    const run = vi.fn(async (file: string, args: string[]) => {
      if (file === '/bin/ps' && args.includes('sess=')) {
        return { stdout: '4242 ttys042\n' }
      }
      if (file === '/usr/bin/pgrep') {
        if (args[1] === '4242') {
          return { stdout: '4243\n' }
        }
        throw emptySelection()
      }
      if (file === '/bin/ps' && args.includes('pid=')) {
        throw emptySelection()
      }
      throw new Error(`Unexpected command: ${file} ${args.join(' ')}`)
    })
    const killProcess = vi.fn()

    await expect(
      killPosixPtySession(4242, '/dev/ttys042', 'darwin', run, killProcess)
    ).resolves.toBe(true)
    expect(run).toHaveBeenCalledWith('/bin/ps', ['-p', '4242', '-o', 'sess=', '-o', 'tty='], {
      timeout: PTY_SESSION_COMMAND_TIMEOUT_MS
    })
    expect(killProcess.mock.calls).toEqual([
      [4242, 'SIGSTOP'],
      [4243, 'SIGSTOP'],
      [4243, 'SIGKILL'],
      [4242, 'SIGKILL']
    ])
  })

  it('leaves Windows ConPTY teardown to node-pty', async () => {
    const run = vi.fn()

    await expect(killPosixPtySession(4242, undefined, 'win32', run)).resolves.toBe(false)
    expect(run).not.toHaveBeenCalled()
  })

  it('does not signal a root whose session identity no longer matches', async () => {
    const run = vi.fn().mockResolvedValue({ stdout: '9999 pts/7\n' })
    const killProcess = vi.fn()

    await expect(killPosixPtySession(4242, '/dev/pts/7', 'linux', run, killProcess)).resolves.toBe(
      false
    )
    expect(killProcess).not.toHaveBeenCalled()
  })

  it('does not signal a reused Linux session leader on a different TTY', async () => {
    const run = vi.fn().mockResolvedValue({ stdout: '4242 pts/99\n' })
    const killProcess = vi.fn()

    await expect(killPosixPtySession(4242, '/dev/pts/7', 'linux', run, killProcess)).resolves.toBe(
      false
    )
    expect(killProcess).not.toHaveBeenCalled()
  })

  it('resumes the frozen root when a discovered child exits before it can be frozen', async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '4242 pts/7\n' })
      .mockResolvedValueOnce({ stdout: '4243\n' })
    const killProcess = vi.fn((pid: number, signal: NodeJS.Signals) => {
      if (pid === 4243 && signal === 'SIGSTOP') {
        throw Object.assign(new Error('gone'), { code: 'ESRCH' })
      }
    })

    await expect(killPosixPtySession(4242, '/dev/pts/7', 'linux', run, killProcess)).resolves.toBe(
      false
    )
    expect(killProcess.mock.calls).toEqual([
      [4242, 'SIGSTOP'],
      [4243, 'SIGSTOP'],
      [4242, 'SIGCONT']
    ])
  })

  it('resumes frozen processes when descendant discovery fails', async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '4242 pts/7\n' })
      .mockRejectedValueOnce(new Error('pgrep unavailable'))
    const killProcess = vi.fn()

    await expect(killPosixPtySession(4242, '/dev/pts/7', 'linux', run, killProcess)).resolves.toBe(
      false
    )
    expect(killProcess.mock.calls).toEqual([
      [4242, 'SIGSTOP'],
      [4242, 'SIGCONT']
    ])
  })

  it('fails closed when a captured process remains runnable after SIGKILL', async () => {
    const run = vi.fn(async (file: string) => {
      if (file === '/usr/bin/pgrep') {
        throw emptySelection()
      }
      if (run.mock.calls.length === 1) {
        return { stdout: '4242 pts/7\n' }
      }
      return { stdout: '4242 D\n' }
    })
    const killProcess = vi.fn()

    await expect(killPosixPtySession(4242, '/dev/pts/7', 'linux', run, killProcess)).resolves.toBe(
      false
    )
  })

  it('uses bounded targeted command timeouts for ownership, children, and verification', async () => {
    const run = vi.fn(async (file: string, _args?: string[], _options?: { timeout: number }) => {
      if (file === '/usr/bin/pgrep') {
        throw emptySelection()
      }
      if (run.mock.calls.length === 1) {
        return { stdout: '4242 pts/7\n' }
      }
      throw emptySelection()
    })

    await expect(killPosixPtySession(4242, '/dev/pts/7', 'linux', run, vi.fn())).resolves.toBe(true)
    expect(run).toHaveBeenNthCalledWith(1, '/bin/ps', ['-p', '4242', '-o', 'sid=', '-o', 'tty='], {
      timeout: PTY_SESSION_COMMAND_TIMEOUT_MS
    })
    expect(run).toHaveBeenNthCalledWith(2, '/usr/bin/pgrep', ['-P', '4242'], {
      timeout: expect.any(Number)
    })
    expect(run.mock.calls[1]?.[2]?.timeout).toBeLessThanOrEqual(PTY_SESSION_COMMAND_TIMEOUT_MS)
    expect(run).toHaveBeenNthCalledWith(3, '/bin/ps', ['-p', '4242', '-o', 'pid=', '-o', 'stat='], {
      timeout: PTY_SESSION_VERIFY_TIMEOUT_MS
    })
  })
})
