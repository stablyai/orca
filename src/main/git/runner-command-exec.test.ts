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

import {
  commandExecFileAsync,
  ghExecFileAsync,
  gitExecFileAsync,
  gitStreamStdout,
  translateWslOutputPaths,
  wslAwareSpawn
} from './runner'

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
    const rejection = expect(promise).rejects.toThrow(/git(?:\.exe)? timed out\./i)
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

  it('rejects gh executions that never call back using the default timeout', async () => {
    const child = createMockChildProcess(1234)
    execFileMock.mockReturnValue(child)

    const promise = ghExecFileAsync(['api', 'repos/stablyai/orca/issues/5388'], {
      cwd: '/repo'
    })
    const rejection = expect(promise).rejects.toThrow('gh timed out.')
    await vi.advanceTimersByTimeAsync(30_000)

    await rejection
    expect(child.kill).toHaveBeenCalled()
  })

  it('honors explicit gh timeouts', async () => {
    const child = createMockChildProcess(1234)
    execFileMock.mockReturnValue(child)

    const promise = ghExecFileAsync(['api', 'repos/stablyai/orca/issues/5388'], {
      cwd: '/repo',
      timeout: 1234
    })
    const rejection = expect(promise).rejects.toThrow('gh timed out.')
    await vi.advanceTimersByTimeAsync(1233)
    expect(child.kill).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)

    await rejection
    expect(child.kill).toHaveBeenCalled()
  })

  it('runs gh non-interactively while preserving explicit env', async () => {
    const child = createMockChildProcess(1234)
    let capturedEnv: NodeJS.ProcessEnv | undefined
    execFileMock.mockImplementation((_cmd, _args, opts, cb) => {
      capturedEnv = opts.env
      cb(null, 'ok', '')
      return child
    })

    await ghExecFileAsync(['api', 'user'], {
      cwd: '/repo',
      env: { ...process.env, GH_PROMPT_DISABLED: '0', ORCA_TEST_ENV: 'kept' },
      timeout: 1234
    })

    expect(capturedEnv?.GH_PROMPT_DISABLED).toBe('0')
    expect(capturedEnv?.ORCA_TEST_ENV).toBe('kept')
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

  it('probes core.sshCommand for opted-in network git calls', async () => {
    const child = createMockChildProcess(1234)
    const calls: { args: string[]; env: NodeJS.ProcessEnv }[] = []
    execFileMock.mockImplementation((_cmd, args, opts, cb) => {
      calls.push({ args, env: opts.env })
      cb(null, args[0] === 'config' ? 'ssh -F ~/.ssh/github-work -i ~/.ssh/work_key\n' : '', '')
      return child
    })

    await gitExecFileAsync(['fetch', 'origin'], {
      cwd: '/repo',
      env: {},
      useConfiguredSshCommandForNetwork: true
    })

    expect(calls[0]?.args).toEqual(['config', '--get', 'core.sshCommand'])
    expect(calls[0]?.env.GIT_TERMINAL_PROMPT).toBe('0')
    expect(calls[0]?.env.GIT_SSH_COMMAND).toBeUndefined()
    expect(calls[1]?.args).toEqual(['fetch', 'origin'])
    expect(calls[1]?.env.GIT_SSH_COMMAND).toBe(
      'ssh -F ~/.ssh/github-work -i ~/.ssh/work_key -o BatchMode=yes'
    )
  })

  it('replaces configured BatchMode for opted-in mergeable OpenSSH commands', async () => {
    const child = createMockChildProcess(1234)
    let capturedEnv: NodeJS.ProcessEnv | undefined
    execFileMock.mockImplementation((_cmd, args, opts, cb) => {
      if (args[0] === 'config') {
        cb(null, 'ssh -o BatchMode=no -i ~/.ssh/personal\n', '')
      } else {
        capturedEnv = opts.env
        cb(null, '', '')
      }
      return child
    })

    await gitExecFileAsync(['fetch', 'origin'], {
      cwd: '/repo',
      env: {},
      useConfiguredSshCommandForNetwork: true
    })

    expect(capturedEnv?.GIT_SSH_COMMAND).toBe('ssh -i ~/.ssh/personal -o BatchMode=yes')
  })

  it('merges quoted ssh.exe command shapes for opted-in network calls', async () => {
    const child = createMockChildProcess(1234)
    let capturedEnv: NodeJS.ProcessEnv | undefined
    execFileMock.mockImplementation((_cmd, args, opts, cb) => {
      if (args[0] === 'config') {
        cb(null, '"C:/Program Files/Git/usr/bin/ssh.exe" -F ~/.ssh/config\n', '')
      } else {
        capturedEnv = opts.env
        cb(null, '', '')
      }
      return child
    })

    await gitExecFileAsync(['fetch', 'origin'], {
      cwd: '/repo',
      env: {},
      useConfiguredSshCommandForNetwork: true
    })

    expect(capturedEnv?.GIT_SSH_COMMAND).toBe(
      "'C:/Program Files/Git/usr/bin/ssh.exe' -F ~/.ssh/config -o BatchMode=yes"
    )
  })

  it('merges unquoted Windows ssh.exe paths for opted-in network calls', async () => {
    const child = createMockChildProcess(1234)
    let capturedEnv: NodeJS.ProcessEnv | undefined
    execFileMock.mockImplementation((_cmd, args, opts, cb) => {
      if (args[0] === 'config') {
        cb(null, `${String.raw`C:\Git\usr\bin\ssh.exe -i C:\Users\me\.ssh\work_key`}\n`, '')
      } else {
        capturedEnv = opts.env
        cb(null, '', '')
      }
      return child
    })

    await gitExecFileAsync(['fetch', 'origin'], {
      cwd: '/repo',
      env: {},
      useConfiguredSshCommandForNetwork: true
    })

    expect(capturedEnv?.GIT_SSH_COMMAND).toBe(
      String.raw`'C:\Git\usr\bin\ssh.exe' -i 'C:\Users\me\.ssh\work_key' -o BatchMode=yes`
    )
  })

  it('passes through unmergeable core.sshCommand wrappers without generic fallback', async () => {
    const child = createMockChildProcess(1234)
    let capturedEnv: NodeJS.ProcessEnv | undefined
    execFileMock.mockImplementation((_cmd, args, opts, cb) => {
      if (args[0] === 'config') {
        cb(null, '/usr/local/bin/work-ssh-wrapper --account work\n', '')
      } else {
        capturedEnv = opts.env
        cb(null, '', '')
      }
      return child
    })

    await gitExecFileAsync(['fetch', 'origin'], {
      cwd: '/repo',
      env: {},
      useConfiguredSshCommandForNetwork: true
    })

    expect(capturedEnv?.GIT_TERMINAL_PROMPT).toBe('0')
    expect(capturedEnv?.GIT_ASKPASS).toBe('')
    expect(capturedEnv?.SSH_ASKPASS).toBe('')
    expect(capturedEnv?.GIT_SSH_COMMAND).toBeUndefined()
  })

  it('passes through shell-expanding OpenSSH configs without changing expansion semantics', async () => {
    const child = createMockChildProcess(1234)
    let capturedEnv: NodeJS.ProcessEnv | undefined
    execFileMock.mockImplementation((_cmd, args, opts, cb) => {
      if (args[0] === 'config') {
        cb(null, 'ssh -i "$HOME/.ssh/work_key"\n', '')
      } else {
        capturedEnv = opts.env
        cb(null, '', '')
      }
      return child
    })

    await gitExecFileAsync(['fetch', 'origin'], {
      cwd: '/repo',
      env: {},
      useConfiguredSshCommandForNetwork: true
    })

    expect(capturedEnv?.GIT_TERMINAL_PROMPT).toBe('0')
    expect(capturedEnv?.GIT_SSH_COMMAND).toBeUndefined()
  })

  it('falls back to generic batch-mode SSH when opted-in config is unset', async () => {
    const child = createMockChildProcess(1234)
    let capturedEnv: NodeJS.ProcessEnv | undefined
    execFileMock.mockImplementation((_cmd, args, opts, cb) => {
      if (args[0] === 'config') {
        cb(Object.assign(new Error('missing'), { code: 1 }), '', '')
      } else {
        capturedEnv = opts.env
        cb(null, '', '')
      }
      return child
    })

    await gitExecFileAsync(['fetch', 'origin'], {
      cwd: '/repo',
      env: {},
      useConfiguredSshCommandForNetwork: true
    })

    expect(capturedEnv?.GIT_SSH_COMMAND).toBe('ssh -o BatchMode=yes')
  })

  it('preserves explicit GIT_SSH_COMMAND and skips the opted-in config probe', async () => {
    const child = createMockChildProcess(1234)
    let capturedEnv: NodeJS.ProcessEnv | undefined
    execFileMock.mockImplementation((_cmd, _args, opts, cb) => {
      capturedEnv = opts.env
      cb(null, '', '')
      return child
    })

    await gitExecFileAsync(['fetch', 'origin'], {
      cwd: '/repo',
      env: { GIT_SSH_COMMAND: 'custom-ssh -o IdentityAgent=none' },
      useConfiguredSshCommandForNetwork: true
    })

    expect(execFileMock).toHaveBeenCalledTimes(1)
    expect(capturedEnv?.GIT_SSH_COMMAND).toBe('custom-ssh -o IdentityAgent=none')
    expect(capturedEnv?.GIT_TERMINAL_PROMPT).toBe('0')
  })

  it('routes git through the selected WSL distro login shell when requested', async () => {
    await withPlatform('win32', async () => {
      const child = createMockChildProcess(1234)
      execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
        cb(null, 'ok', '')
        return child
      })

      await gitExecFileAsync(['status', '--short'], {
        cwd: String.raw`C:\repo`,
        wslDistro: 'Ubuntu'
      })

      expect(execFileMock).toHaveBeenCalledWith(
        'wsl.exe',
        ['-d', 'Ubuntu', '--', 'sh', '-lc', expect.any(String)],
        expect.objectContaining({ cwd: undefined }),
        expect.any(Function)
      )
      const shellCommand = execFileMock.mock.calls[0]?.[1]?.[5] as string
      expect(shellCommand).toContain('getent passwd')
      expect(shellCommand).toContain('exec "\\$_orca_wsl_shell" -ilc')
      expect(shellCommand).toContain('/mnt/c/repo')
      expect(shellCommand).toContain("'git'")
      expect(shellCommand).toContain('status')
      expect(shellCommand).toContain('--short')
    })
  })

  it('forwards synthesized network SSH policy into the selected WSL distro', async () => {
    await withPlatform('win32', async () => {
      const child = createMockChildProcess(1234)
      let capturedEnv: NodeJS.ProcessEnv | undefined
      execFileMock.mockImplementation((_cmd, args, opts, cb) => {
        const shellCommand = args[5] as string
        if (shellCommand.includes("'config'")) {
          cb(Object.assign(new Error('missing'), { code: 1 }), '', '')
        } else {
          capturedEnv = opts.env
          cb(null, '', '')
        }
        return child
      })

      await gitExecFileAsync(['fetch', 'origin'], {
        cwd: String.raw`C:\repo`,
        env: {},
        wslDistro: 'Ubuntu',
        useConfiguredSshCommandForNetwork: true
      })

      expect(capturedEnv?.GIT_SSH_COMMAND).toBe('ssh -o BatchMode=yes')
      expect((capturedEnv?.WSLENV ?? '').split(':')).toContain('GIT_SSH_COMMAND')
    })
  })

  it('forwards synthesized network SSH policy when a UNC cwd selects WSL', async () => {
    await withPlatform('win32', async () => {
      const child = createMockChildProcess(1234)
      let capturedEnv: NodeJS.ProcessEnv | undefined
      execFileMock.mockImplementation((_cmd, args, opts, cb) => {
        const shellCommand = args[5] as string
        if (shellCommand.includes("'config'")) {
          cb(Object.assign(new Error('missing'), { code: 1 }), '', '')
        } else {
          capturedEnv = opts.env
          cb(null, '', '')
        }
        return child
      })

      await gitExecFileAsync(['fetch', 'origin'], {
        cwd: String.raw`\\wsl.localhost\Ubuntu\home\me\repo`,
        env: {},
        useConfiguredSshCommandForNetwork: true
      })

      expect(capturedEnv?.GIT_SSH_COMMAND).toBe('ssh -o BatchMode=yes')
      expect((capturedEnv?.WSLENV ?? '').split(':')).toContain('GIT_SSH_COMMAND')
    })
  })

  it('quotes WSL-routed executables before entering the shell', async () => {
    await withPlatform('win32', async () => {
      const child = createMockChildProcess(1234)
      spawnMock.mockReturnValue(child)

      wslAwareSpawn('codex; touch /tmp/pwned', ['--version'], {
        cwd: String.raw`C:\repo`,
        stdio: ['pipe', 'pipe', 'pipe'],
        wslDistro: 'Ubuntu',
        useWslLoginShell: true
      })

      const shellCommand = spawnMock.mock.calls[0]?.[1]?.[5] as string
      expect(shellCommand).toContain(String.raw`'\''codex; touch /tmp/pwned'\'' '\''--version'\''`)
    })
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

  it('handles a late spawn error after cancellation', async () => {
    const child = createMockChildProcess(0)
    spawnMock.mockReturnValue(child)
    const controller = new AbortController()

    const promise = gitStreamStdout(['status'], {
      cwd: '/repo',
      signal: controller.signal,
      onStdout: () => {}
    })
    controller.abort()

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    expect(() => child.emit('error', new Error('spawn ENOENT'))).not.toThrow()
  })
})

describe('translateWslOutputPaths', () => {
  it('translates WSL output paths with an explicit distro for Windows cwd routing', () => {
    expect(
      translateWslOutputPaths('worktree /mnt/c/Users/me/repo-feature\n', 'C:\\Users\\me\\repo', {
        wslDistro: 'Ubuntu'
      })
    ).toBe('worktree C:\\Users\\me\\repo-feature\n')
  })
})
