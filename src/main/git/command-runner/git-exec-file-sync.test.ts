import type * as ChildProcess from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { execFileSync } = vi.hoisted(() => ({
  execFileSync: vi.fn((_binary: string, _args: readonly string[], _options?: unknown) => 'out')
}))
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcess>()),
  execFileSync
}))

import { gitExecFileSync } from './git-exec-file-sync'
import { untranslatedGitOutputEnv } from './git-process-env'
import { setLocalGitRuntimeRouter } from './local-git-runtime-route'

const originalPlatform = process.platform

afterEach(() => {
  execFileSync.mockClear()
  setLocalGitRuntimeRouter(null)
  Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
})

describe('gitExecFileSync', () => {
  it('runs host Git even in a WSL project, so the main thread never waits on wsl.exe', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    setLocalGitRuntimeRouter(() => 'Ubuntu')
    gitExecFileSync(['rev-parse', '--git-path', 'hooks'], {
      cwd: String.raw`C:\src\app`,
      hostGit: true
    })
    const [binary] = execFileSync.mock.calls[0] ?? ['']
    expect(binary.toLowerCase()).not.toContain('wsl')
  })

  it('spawns exactly what it did before hostGit existed on POSIX', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    gitExecFileSync(['rev-parse', '--git-path', 'orca/setup-runner.sh'], {
      cwd: '/test/worktree',
      hostGit: true
    })
    expect(execFileSync.mock.calls).toEqual([
      [
        'git',
        ['rev-parse', '--git-path', 'orca/setup-runner.sh'],
        {
          cwd: '/test/worktree',
          encoding: 'utf-8',
          env: untranslatedGitOutputEnv(),
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 15_000,
          windowsHide: true
        }
      ]
    ])
  })
})
