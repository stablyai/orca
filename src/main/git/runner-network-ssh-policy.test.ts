import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }))
vi.mock('node:child_process', () => ({
  execFile: execFileMock,
  execFileSync: vi.fn(),
  spawn: vi.fn()
}))

import { gitExecFileAsync } from './runner'
import {
  GitAdmissionScheduler,
  _resetGitAdmissionForTests
} from './command-runner/git-subprocess-admission'

class MockChildProcess extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  kill = vi.fn()
  constructor(readonly pid: number) {
    super()
  }
}
const createMockChildProcess = (pid: number): MockChildProcess => new MockChildProcess(pid)

beforeEach(() => {
  execFileMock.mockReset()
})
afterEach(() => _resetGitAdmissionForTests())

describe('network Git SSH policy', () => {
  it('probes core.sshCommand for opted-in network git calls', async () => {
    const child = createMockChildProcess(1234)
    const calls: { args: string[]; env: NodeJS.ProcessEnv }[] = []
    execFileMock.mockImplementation((_cmd, args, opts, cb) => {
      calls.push({ args, env: opts.env })
      cb(
        null,
        args[0] === 'config'
          ? 'core.sshcommand\nssh -F ~/.ssh/github-work -i ~/.ssh/work_key\0'
          : '',
        ''
      )
      return child
    })

    await gitExecFileAsync(['fetch', 'origin'], {
      cwd: '/repo',
      env: {},
      useConfiguredSshCommandForNetwork: true
    })

    expect(calls[0]?.args).toEqual([
      'config',
      '--null',
      '--get-regexp',
      '^(core\\.sshcommand|ssh\\.variant)$'
    ])
    expect(calls[0]?.env.GIT_TERMINAL_PROMPT).toBe('0')
    expect(calls[0]?.env.GIT_SSH_COMMAND).toBeUndefined()
    expect(calls[1]?.args).toEqual(['fetch', 'origin'])
    expect(calls[1]?.env.GIT_SSH_COMMAND).toBe(
      'ssh -F ~/.ssh/github-work -i ~/.ssh/work_key -o BatchMode=yes'
    )
  })

  it('admits the core.sshCommand probe before spawning it', async () => {
    const scheduler = new GitAdmissionScheduler({ generalCap: 1, generalHeadroom: 0 })
    _resetGitAdmissionForTests(scheduler)
    const blocker = await scheduler.acquire({ args: ['status'], cwd: '/repo', tier: 'status' })
    const calls: string[][] = []
    execFileMock.mockImplementation((_cmd, args, _opts, cb) => {
      const child = createMockChildProcess(1234 + calls.length)
      calls.push(args)
      cb(null, '', '')
      queueMicrotask(() => child.emit('close', 0, null))
      return child
    })

    const pending = gitExecFileAsync(['fetch', '--no-write-fetch-head', 'origin'], {
      cwd: '/repo',
      env: {},
      useConfiguredSshCommandForNetwork: true
    })
    await Promise.resolve()
    expect(execFileMock).not.toHaveBeenCalled()

    blocker.release()
    await pending

    expect(calls).toEqual([
      ['config', '--null', '--get-regexp', '^(core\\.sshcommand|ssh\\.variant)$'],
      ['fetch', '--no-write-fetch-head', 'origin']
    ])
  })

  it('replaces configured BatchMode for opted-in mergeable OpenSSH commands', async () => {
    const child = createMockChildProcess(1234)
    let capturedEnv: NodeJS.ProcessEnv | undefined
    execFileMock.mockImplementation((_cmd, args, opts, cb) => {
      if (args[0] === 'config') {
        cb(null, 'core.sshcommand\nssh -o BatchMode=no -i ~/.ssh/personal\0', '')
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
        cb(null, 'core.sshcommand\n"C:/Program Files/Git/usr/bin/ssh.exe" -F ~/.ssh/config\0', '')
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
        cb(
          null,
          `core.sshcommand\n${String.raw`C:\Git\usr\bin\ssh.exe -i C:\Users\me\.ssh\work_key`}\0`,
          ''
        )
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
        cb(null, 'core.sshcommand\n/usr/local/bin/work-ssh-wrapper --account work\0', '')
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
        cb(null, 'core.sshcommand\nssh -i "$HOME/.ssh/work_key"\0', '')
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

  it.each([
    { GIT_SSH_COMMAND: 'custom-ssh -o IdentityAgent=none' },
    { GIT_SSH: 'custom-ssh-wrapper' }
  ])('preserves explicit SSH environment and skips the config probe (%j)', async (env) => {
    const child = createMockChildProcess(1234)
    let capturedEnv: NodeJS.ProcessEnv | undefined
    execFileMock.mockImplementation((_cmd, _args, opts, cb) => {
      capturedEnv = opts.env
      cb(null, '', '')
      return child
    })

    await gitExecFileAsync(['fetch', 'origin'], {
      cwd: '/repo',
      env,
      useConfiguredSshCommandForNetwork: true
    })

    expect(execFileMock).toHaveBeenCalledTimes(1)
    expect(capturedEnv?.GIT_SSH_COMMAND).toBe(env.GIT_SSH_COMMAND)
    expect(capturedEnv?.GIT_SSH).toBe(env.GIT_SSH)
    expect(capturedEnv?.GIT_TERMINAL_PROMPT).toBe('0')
  })

  it.each(['ETIMEDOUT', 'ENOBUFS', 'ABORT_ERR'])(
    'does not select a generic SSH command after a %s config failure',
    async (code) => {
      const error = Object.assign(new Error('SSH configuration unavailable'), { code })
      execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
        cb(error, '', '')
        return createMockChildProcess(1234)
      })
      await expect(gitExecFileAsync(['fetch', 'origin'], { cwd: '/repo', env: {} })).rejects.toBe(
        error
      )
      expect(execFileMock).toHaveBeenCalledTimes(1)
      expect(execFileMock.mock.calls[0]?.[1]?.[0]).toBe('config')
    }
  )
})
