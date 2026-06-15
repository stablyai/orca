import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock, execFileSyncMock, spawnMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  execFileSyncMock: vi.fn(),
  spawnMock: vi.fn()
}))

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
  execFileSync: execFileSyncMock,
  spawn: spawnMock
}))

import { commandExecFileAsync, gitExecFileAsync, gitStreamStdout } from './runner'

type MockChildProcess = EventEmitter & {
  stdout: EventEmitter
  stderr: EventEmitter
  pid: number
  kill: ReturnType<typeof vi.fn>
  unref?: ReturnType<typeof vi.fn>
}

function createMockChildProcess(pid: number): MockChildProcess {
  const child = new EventEmitter() as MockChildProcess
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.pid = pid
  child.kill = vi.fn()
  return child
}

function createMockTaskkillProcess(): MockChildProcess {
  const child = createMockChildProcess(9000)
  child.unref = vi.fn()
  return child
}

async function withPlatform<T>(platform: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
  const original = process.platform
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  try {
    return await fn()
  } finally {
    Object.defineProperty(process, 'platform', { configurable: true, value: original })
  }
}

describe('commandExecFileAsync Windows command shims', () => {
  const originalComSpec = process.env.ComSpec

  beforeEach(() => {
    process.env.ComSpec = 'C:\\Windows\\System32\\cmd.exe'
    execFileMock.mockReset()
    execFileSyncMock.mockReset()
    spawnMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
    if (originalComSpec === undefined) {
      delete process.env.ComSpec
    } else {
      process.env.ComSpec = originalComSpec
    }
  })

  it('kills aborted Windows .cmd shim executions as a process tree', async () => {
    await withPlatform('win32', async () => {
      const command = createMockChildProcess(1234)
      const taskkill = createMockTaskkillProcess()
      spawnMock.mockImplementation((cmd: string) => (cmd === 'taskkill' ? taskkill : command))

      const controller = new AbortController()
      const promise = commandExecFileAsync('C:\\tools\\pnpm.cmd', ['--version'], {
        cwd: 'C:\\repo',
        signal: controller.signal
      })
      const rejection = expect(promise).rejects.toMatchObject({ name: 'AbortError' })
      controller.abort()

      await rejection
      expect(spawnMock).toHaveBeenCalledWith(
        'taskkill',
        ['/pid', '1234', '/t', '/f'],
        expect.objectContaining({ stdio: 'ignore', windowsHide: true })
      )
      expect(command.kill).not.toHaveBeenCalled()
    })
  })

  it('kills timed-out Windows .cmd shim executions as a process tree', async () => {
    vi.useFakeTimers()
    await withPlatform('win32', async () => {
      const command = createMockChildProcess(1234)
      const taskkill = createMockTaskkillProcess()
      spawnMock.mockImplementation((cmd: string) => (cmd === 'taskkill' ? taskkill : command))

      const promise = commandExecFileAsync('C:\\tools\\pnpm.cmd', ['store', 'prune'], {
        cwd: 'C:\\repo',
        timeout: 1000
      })
      const rejection = expect(promise).rejects.toThrow('C:\\tools\\pnpm.cmd timed out.')
      await vi.advanceTimersByTimeAsync(1000)

      await rejection
      expect(spawnMock).toHaveBeenCalledWith(
        'taskkill',
        ['/pid', '1234', '/t', '/f'],
        expect.objectContaining({ stdio: 'ignore', windowsHide: true })
      )
      expect(command.kill).not.toHaveBeenCalled()
      expect(command.stdout.listenerCount('data')).toBe(0)
      expect(command.stderr.listenerCount('data')).toBe(0)
      expect(command.listenerCount('error')).toBe(0)
      expect(command.listenerCount('close')).toBe(0)
    })
  })

  it('kills over-buffer Windows .cmd shim executions as a process tree', async () => {
    await withPlatform('win32', async () => {
      const command = createMockChildProcess(1234)
      const taskkill = createMockTaskkillProcess()
      spawnMock.mockImplementation((cmd: string) => (cmd === 'taskkill' ? taskkill : command))

      const promise = commandExecFileAsync('C:\\tools\\pnpm.cmd', ['store', 'prune'], {
        cwd: 'C:\\repo',
        maxBuffer: 2
      })
      const rejection = expect(promise).rejects.toThrow(
        'C:\\tools\\pnpm.cmd stdout exceeded maxBuffer.'
      )
      command.stdout.emit('data', Buffer.from('too much output'))

      await rejection
      expect(spawnMock).toHaveBeenCalledWith(
        'taskkill',
        ['/pid', '1234', '/t', '/f'],
        expect.objectContaining({ stdio: 'ignore', windowsHide: true })
      )
      expect(command.kill).not.toHaveBeenCalled()
      expect(command.stdout.listenerCount('data')).toBe(0)
      expect(command.stderr.listenerCount('data')).toBe(0)
      expect(command.listenerCount('error')).toBe(0)
      expect(command.listenerCount('close')).toBe(0)
    })
  })

  it('removes listeners after successful Windows .cmd shim executions', async () => {
    await withPlatform('win32', async () => {
      const command = createMockChildProcess(1234)
      spawnMock.mockReturnValue(command)

      const promise = commandExecFileAsync('C:\\tools\\pnpm.cmd', ['--version'], {
        cwd: 'C:\\repo'
      })
      command.stdout.emit('data', Buffer.from('9.1.0\n'))
      command.stderr.emit('data', Buffer.from('notice\n'))
      command.emit('close', 0)

      await expect(promise).resolves.toEqual({ stdout: '9.1.0\n', stderr: 'notice\n' })
      expect(command.stdout.listenerCount('data')).toBe(0)
      expect(command.stderr.listenerCount('data')).toBe(0)
      expect(command.listenerCount('error')).toBe(0)
      expect(command.listenerCount('close')).toBe(0)
    })
  })
})

describe('runner execFile timeout handling', () => {
  beforeEach(() => {
    execFileMock.mockReset()
    execFileSyncMock.mockReset()
    spawnMock.mockReset()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('rejects command executions when execFile never calls back after timeout', async () => {
    const child = createMockChildProcess(1234)
    execFileMock.mockReturnValue(child)

    const promise = commandExecFileAsync('git', ['status'], {
      cwd: '/repo',
      timeout: 1000
    })
    const rejection = expect(promise).rejects.toThrow('git timed out.')
    await vi.advanceTimersByTimeAsync(1000)

    await rejection
    expect(child.kill).toHaveBeenCalled()
  })

  it('rejects git executions when execFile never calls back after timeout', async () => {
    const child = createMockChildProcess(1234)
    execFileMock.mockReturnValue(child)

    const promise = gitExecFileAsync(['status'], {
      cwd: '/repo',
      timeout: 1000
    })
    const rejection = expect(promise).rejects.toThrow('git timed out.')
    await vi.advanceTimersByTimeAsync(1000)

    await rejection
    expect(child.kill).toHaveBeenCalled()
  })

  // Issue #5308: git read-path calls must be forced non-interactive so a
  // credential / SSH host-key prompt fails fast instead of blocking forever on
  // stdin and wedging the serve runtime for all clients.
  it('runs git non-interactively so a prompt fails fast instead of hanging', async () => {
    const child = createMockChildProcess(1234)
    let capturedEnv: NodeJS.ProcessEnv | undefined
    execFileMock.mockImplementation((_cmd, _args, opts, cb) => {
      capturedEnv = opts.env
      cb(null, '', '')
      return child
    })

    await gitExecFileAsync(['worktree', 'list', '--porcelain', '-z'], { cwd: '/home5/Brian' })

    expect(capturedEnv?.GIT_TERMINAL_PROMPT).toBe('0')
    expect(capturedEnv?.GIT_ASKPASS).toBe('')
    expect(capturedEnv?.SSH_ASKPASS).toBe('')
    expect(capturedEnv?.GIT_SSH_COMMAND).toContain('BatchMode=yes')
  })
})

describe('gitStreamStdout', () => {
  beforeEach(() => {
    spawnMock.mockReset()
  })

  it('streams chunks to onStdout and resolves cleanly on a zero exit', async () => {
    const child = createMockChildProcess(1234)
    spawnMock.mockReturnValue(child)

    const chunks: string[] = []
    const promise = gitStreamStdout(['status', '--porcelain=v2'], {
      cwd: '/repo',
      onStdout: (chunk) => {
        chunks.push(chunk)
      }
    })
    child.stdout.emit('data', Buffer.from('? a.txt\n'))
    child.stdout.emit('data', Buffer.from('? b.txt\n'))
    child.emit('close', 0)

    await expect(promise).resolves.toEqual({ stoppedEarly: false })
    expect(chunks).toEqual(['? a.txt\n', '? b.txt\n'])
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('kills git early and resolves stoppedEarly when onStdout requests a stop', async () => {
    const child = createMockChildProcess(1234)
    spawnMock.mockReturnValue(child)

    let calls = 0
    const promise = gitStreamStdout(['status'], {
      cwd: '/repo',
      // Stop after the first chunk — mirrors a parser hitting its entry limit.
      onStdout: () => {
        calls += 1
        return true
      }
    })
    child.stdout.emit('data', Buffer.from('? a.txt\n'))

    await expect(promise).resolves.toEqual({ stoppedEarly: true })
    expect(child.kill).toHaveBeenCalled()
    expect(calls).toBe(1)
  })

  it('rejects when stdout exceeds the maxBuffer backstop', async () => {
    const child = createMockChildProcess(1234)
    spawnMock.mockReturnValue(child)

    const promise = gitStreamStdout(['status'], {
      cwd: '/repo',
      maxBuffer: 4,
      onStdout: () => {}
    })
    const rejection = expect(promise).rejects.toThrow('git stdout exceeded maxBuffer.')
    child.stdout.emit('data', Buffer.from('way too much'))

    await rejection
    expect(child.kill).toHaveBeenCalled()
  })

  it('rejects on a non-zero exit with stderr context', async () => {
    const child = createMockChildProcess(1234)
    spawnMock.mockReturnValue(child)

    const promise = gitStreamStdout(['status'], { cwd: '/repo', onStdout: () => {} })
    const rejection = expect(promise).rejects.toThrow('git exited with 128')
    child.stderr.emit('data', Buffer.from('fatal: not a git repository'))
    child.emit('close', 128)

    await rejection
  })

  it('rejects (not crashes) when the onStdout callback throws', async () => {
    const child = createMockChildProcess(1234)
    spawnMock.mockReturnValue(child)

    const promise = gitStreamStdout(['status'], {
      cwd: '/repo',
      onStdout: () => {
        throw new Error('parser blew up')
      }
    })
    const rejection = expect(promise).rejects.toThrow('parser blew up')
    child.stdout.emit('data', Buffer.from('? a.txt\n'))

    await rejection
    expect(child.kill).toHaveBeenCalled()
  })
})
