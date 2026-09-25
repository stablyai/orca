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
vi.mock('../observability/instrumentation', () => ({
  withGitSpan: (_attributes: unknown, run: () => unknown) => run()
}))
vi.mock('../diagnostics/main-thread-churn-probe', () => ({ recordSubprocessSpawn: vi.fn() }))

import { gitExecFileAsync } from './runner'
import { _resetGitAdmissionForTests } from './command-runner/git-subprocess-admission'

afterEach(() => _resetGitAdmissionForTests())
import {
  resetWslGitReadEnvironmentForTests,
  seedWslGitReadEnvironmentForTests
} from './wsl-git-read-environment'

const DISTRO = 'Ubuntu'
const WSL_CWD = String.raw`\wsl.localhost\Ubuntu\home\alice\repo`
const LOGIN_ENVIRONMENT = {
  gitPath: '/usr/bin/git',
  home: '/home/alice',
  path: '/home/alice/bin:/usr/bin'
}

function createMockChild(): EventEmitter & { stdout: EventEmitter; stderr: EventEmitter } {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter
    stderr: EventEmitter
  }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  return child
}

function lastArgs(): string[] {
  return execFileMock.mock.calls.at(-1)?.[1] as string[]
}

describe('WSL git read routing', () => {
  beforeEach(() => {
    execFileMock.mockReset()
    execFileMock.mockImplementation((_command, _args, _options, callback) => {
      queueMicrotask(() => callback?.(null, 'ok', ''))
      return createMockChild()
    })
    resetWslGitReadEnvironmentForTests()
    seedWslGitReadEnvironmentForTests(DISTRO, LOGIN_ENVIRONMENT)
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: process.platform })
    resetWslGitReadEnvironmentForTests()
  })

  // Why these two: they are the parse #10917 reports, and they run through the
  // general git options that never opted into the shell-free route.
  it.each([
    ['remote get-url', ['remote', 'get-url', 'origin']],
    ['remote list', ['remote']],
    ['remote show without query', ['remote', 'show', '-n', 'origin']],
    ['symbolic-ref', ['symbolic-ref', '--quiet', '--short', 'HEAD']],
    ['worktree list', ['worktree', 'list', '--porcelain']],
    ['config --get', ['config', '--get', 'remote.origin.url']],
    ['log', ['log', '--oneline', '-n', '1']],
    ['show blob', ['show', ':src/file.ts']]
  ])('runs %s with no shell at all', async (_name, args) => {
    await gitExecFileAsync(args, { cwd: WSL_CWD, wslDistro: DISTRO })

    const resolved = lastArgs()
    expect(resolved).toContain('--exec')
    expect(resolved).toContain('/usr/bin/env')
    expect(resolved).toContain(`PATH=${LOGIN_ENVIRONMENT.path}`)
    // No shell means no rc file, so no banner can reach the parsed stdout.
    expect(resolved).not.toContain('-lc')
    expect(resolved).not.toContain('sh')
    expect(resolved.join(' ')).not.toContain('getent passwd')
  })

  it.each([
    ['commit', ['commit', '-m', 'msg']],
    ['config set', ['config', 'user.email', 'me@example.com']],
    ['remote add', ['remote', 'add', 'upstream', 'https://example.com/r.git']],
    ['remote show with query', ['remote', 'show', 'origin']]
  ])('keeps %s on the login shell', async (_name, args) => {
    await gitExecFileAsync(args, { cwd: WSL_CWD, wslDistro: DISTRO })

    const resolved = lastArgs()
    expect(resolved).toContain('-lc')
    expect(resolved.join(' ')).toContain('getent passwd')
  })
})
