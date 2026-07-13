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
    const toReversedDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, 'toReversed')
    Object.defineProperty(Array.prototype, 'toReversed', {
      configurable: true,
      value: undefined
    })
    const run = vi.fn(async (file: string, args: string[]) => {
      if (file === 'ps' && args.includes('sid=')) {
        return { stdout: '4242 pts/7\n' }
      }
      if (file === 'pgrep') {
        const parents = new Set(args[1]?.split(','))
        if (parents.has('4242')) {
          return { stdout: '4243\n4244\n' }
        }
        if (parents.has('4244')) {
          return { stdout: '4245\n' }
        }
        throw emptySelection()
      }
      if (file === 'ps' && args.includes('ppid=')) {
        const parents = new Map([
          [4243, 4242],
          [4244, 4242],
          [4245, 4244]
        ])
        const selected = args[1]!.split(',').map(Number)
        return { stdout: selected.map((child) => `${child} ${parents.get(child)}`).join('\n') }
      }
      if (file === 'ps' && args.includes('stat=')) {
        return { stdout: '4242 Z\n4243 Z\n4244 Z\n4245 Z\n' }
      }
      throw new Error(`Unexpected command: ${file} ${args.join(' ')}`)
    })
    const killProcess = vi.fn()

    try {
      await expect(
        killPosixPtySession(4242, '/dev/pts/7', 'linux', run, killProcess)
      ).resolves.toBe(true)
    } finally {
      if (toReversedDescriptor) {
        Object.defineProperty(Array.prototype, 'toReversed', toReversedDescriptor)
      } else {
        Reflect.deleteProperty(Array.prototype, 'toReversed')
      }
    }

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
    expect(run).not.toHaveBeenCalledWith('ps', expect.arrayContaining(['-e']), expect.anything())
    expect(run.mock.calls.filter(([file]) => file === 'pgrep')).toHaveLength(3)
  })

  it('validates Darwin root ownership before targeted descendant teardown', async () => {
    const run = vi.fn(async (file: string, args: string[]) => {
      if (file === 'ps' && args.includes('pgid=')) {
        return { stdout: '4242 ttys042\n' }
      }
      if (file === 'pgrep') {
        if (args[1] === '4242') {
          return { stdout: '4243\n' }
        }
        throw emptySelection()
      }
      if (file === 'ps' && args.includes('ppid=')) {
        return { stdout: '4243 4242\n' }
      }
      if (file === 'ps' && args.includes('stat=')) {
        throw emptySelection()
      }
      throw new Error(`Unexpected command: ${file} ${args.join(' ')}`)
    })
    const killProcess = vi.fn()

    await expect(
      killPosixPtySession(4242, '/dev/ttys042', 'darwin', run, killProcess)
    ).resolves.toBe(true)
    expect(run).toHaveBeenCalledTimes(6)
    expect(run).toHaveBeenNthCalledWith(1, 'ps', ['-p', '4242', '-o', 'pgid=', '-o', 'tty='], {
      timeout: PTY_SESSION_COMMAND_TIMEOUT_MS
    })
    expect(run).toHaveBeenNthCalledWith(2, 'ps', ['-p', '4242', '-o', 'pgid=', '-o', 'tty='], {
      timeout: PTY_SESSION_COMMAND_TIMEOUT_MS
    })
    expect(run).toHaveBeenLastCalledWith('ps', ['-p', '4242,4243', '-o', 'pid=', '-o', 'stat='], {
      timeout: expect.any(Number)
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

  it('fails closed when node-pty cannot provide the exact controlling TTY', async () => {
    const run = vi.fn()
    const killProcess = vi.fn()

    await expect(killPosixPtySession(4242, undefined, 'linux', run, killProcess)).resolves.toBe(
      false
    )
    expect(run).not.toHaveBeenCalled()
    expect(killProcess).not.toHaveBeenCalled()
  })

  it('resumes the root when its ownership changes after SIGSTOP', async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '4242 pts/7\n' })
      .mockResolvedValueOnce({ stdout: '9999 pts/7\n' })
    const killProcess = vi.fn()

    await expect(killPosixPtySession(4242, '/dev/pts/7', 'linux', run, killProcess)).resolves.toBe(
      false
    )
    expect(killProcess.mock.calls).toEqual([
      [4242, 'SIGSTOP'],
      [4242, 'SIGCONT']
    ])
  })

  it('resumes the frozen root when a discovered child exits before it can be frozen', async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '4242 pts/7\n' })
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
    const run = vi.fn(async (file: string, args: string[]) => {
      if (file === 'pgrep') {
        throw emptySelection()
      }
      if (file === 'ps' && args.includes('sid=')) {
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
    const run = vi.fn(async (file: string, args?: string[], _options?: { timeout: number }) => {
      if (file === 'pgrep') {
        throw emptySelection()
      }
      if (args?.includes('sid=')) {
        return { stdout: '4242 pts/7\n' }
      }
      throw emptySelection()
    })

    await expect(killPosixPtySession(4242, '/dev/pts/7', 'linux', run, vi.fn())).resolves.toBe(true)
    expect(run).toHaveBeenNthCalledWith(1, 'ps', ['-p', '4242', '-o', 'sid=', '-o', 'tty='], {
      timeout: PTY_SESSION_COMMAND_TIMEOUT_MS
    })
    expect(run).toHaveBeenNthCalledWith(2, 'ps', ['-p', '4242', '-o', 'sid=', '-o', 'tty='], {
      timeout: PTY_SESSION_COMMAND_TIMEOUT_MS
    })
    expect(run).toHaveBeenNthCalledWith(3, 'pgrep', ['-P', '4242'], {
      timeout: expect.any(Number)
    })
    expect(run.mock.calls[2]?.[2]?.timeout).toBeLessThanOrEqual(PTY_SESSION_COMMAND_TIMEOUT_MS)
    expect(run).toHaveBeenNthCalledWith(4, 'ps', ['-p', '4242', '-o', 'pid=', '-o', 'stat='], {
      timeout: expect.any(Number)
    })
    expect(run.mock.calls[3]?.[2]?.timeout).toBeLessThanOrEqual(PTY_SESSION_VERIFY_TIMEOUT_MS)
  })

  it('resumes every frozen process when a stopped child was reparented', async () => {
    const run = vi.fn(async (file: string, args: string[]) => {
      if (file === 'ps' && args.includes('sid=')) {
        return { stdout: '4242 pts/7\n' }
      }
      if (file === 'pgrep') {
        return { stdout: '4243\n' }
      }
      if (file === 'ps' && args.includes('ppid=')) {
        return { stdout: '4243 9999\n' }
      }
      throw new Error(`Unexpected command: ${file} ${args.join(' ')}`)
    })
    const killProcess = vi.fn()

    await expect(killPosixPtySession(4242, '/dev/pts/7', 'linux', run, killProcess)).resolves.toBe(
      false
    )
    expect(killProcess.mock.calls).toEqual([
      [4242, 'SIGSTOP'],
      [4243, 'SIGSTOP'],
      [4242, 'SIGCONT'],
      [4243, 'SIGCONT']
    ])
  })

  it('batches large Darwin trees under one final verification deadline', async () => {
    const rootPid = 5000
    const childPids = Array.from({ length: 129 }, (_, index) => rootPid + index + 1)
    let now = 10_000
    const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => {
      const current = now
      now += 5
      return current
    })
    const run = vi.fn(async (file: string, args: string[], _options?: { timeout: number }) => {
      if (file === 'ps' && args.includes('pgid=')) {
        return { stdout: `${rootPid} ttys042\n` }
      }
      if (file === 'pgrep') {
        if (args[1] === String(rootPid)) {
          return { stdout: childPids.join('\n') }
        }
        throw emptySelection()
      }
      if (file === 'ps' && args.includes('ppid=')) {
        return {
          stdout: args[1]!
            .split(',')
            .map((pid) => `${pid} ${rootPid}`)
            .join('\n')
        }
      }
      if (file === 'ps' && args.includes('stat=')) {
        return {
          stdout: args[1]!
            .split(',')
            .map((pid) => `${pid} Z`)
            .join('\n')
        }
      }
      throw new Error(`Unexpected command: ${file} ${args.join(' ')}`)
    })

    try {
      await expect(
        killPosixPtySession(rootPid, '/dev/ttys042', 'darwin', run, vi.fn())
      ).resolves.toBe(true)
    } finally {
      dateNow.mockRestore()
    }

    const parentChecks = run.mock.calls.filter(
      ([file, args]) => file === 'ps' && args.includes('ppid=')
    )
    const finalChecks = run.mock.calls.filter(
      ([file, args]) => file === 'ps' && args.includes('stat=')
    )
    expect(parentChecks).toHaveLength(3)
    expect(finalChecks).toHaveLength(3)
    for (const [, args, options] of [...parentChecks, ...finalChecks]) {
      expect(args[1]!.split(',').length).toBeLessThanOrEqual(64)
      expect(options!.timeout).toBeGreaterThan(0)
      expect(options!.timeout).toBeLessThanOrEqual(PTY_SESSION_COMMAND_TIMEOUT_MS)
    }
    const finalTimeouts = finalChecks.map(([, , options]) => options!.timeout)
    expect(finalTimeouts.at(-1)).toBeLessThan(finalTimeouts[0])
    expect(finalTimeouts[0]).toBeLessThanOrEqual(PTY_SESSION_VERIFY_TIMEOUT_MS)
  })
})
