/**
 * The setup runner's path lookup with the D1c Git router on: read from the worktree's link, no Git
 * process; with it off, the host Git lookup main runs.
 */
import type * as GitRunner from './git/runner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeHookTestRepo } from './hooks-test-fixtures'
import { setLocalGitRuntimeRouter } from './git/command-runner/local-git-runtime-route'

vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  rmSync: vi.fn(),
  chmodSync: vi.fn()
}))

const { gitExecFileSyncMock, readWorktreeGitPathMock } = vi.hoisted(() => ({
  gitExecFileSyncMock: vi.fn(() => '/mnt/c/src/app/.git/orca/setup-runner.sh\n'),
  readWorktreeGitPathMock: vi.fn(
    (_worktree: string, _relative: string, _roots: readonly string[]): string | null =>
      String.raw`C:\src\app\.git\worktrees\fix\orca\setup-runner.sh`
  )
}))

vi.mock('./git/runner', async () => ({
  ...(await vi.importActual<typeof GitRunner>('./git/runner')),
  gitExecFileSync: gitExecFileSyncMock
}))
vi.mock('./git/worktree-git-path', () => ({ readWorktreeGitPath: readWorktreeGitPathMock }))

const originalPlatform = process.platform
const WORKTREE = String.raw`C:\src\app-fix`

beforeEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  gitExecFileSyncMock.mockClear()
  readWorktreeGitPathMock.mockClear()
})

afterEach(() => {
  setLocalGitRuntimeRouter(null)
  Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
})

async function create() {
  const { createSetupRunnerScript } = await import('./worktree-runner-script')
  return createSetupRunnerScript(
    { ...makeHookTestRepo(), path: String.raw`C:\src\app` },
    WORKTREE,
    'echo hello',
    { wslDistro: 'Ubuntu' }
  )
}

describe('createSetupRunnerScript git path for a WSL-runtime drive project', () => {
  it('reads the worktree link, starting no Git, with the router on', async () => {
    setLocalGitRuntimeRouter(() => 'Ubuntu')
    const result = await create()
    expect(readWorktreeGitPathMock).toHaveBeenCalledWith(
      WORKTREE,
      'orca/setup-runner.sh',
      expect.arrayContaining(['/mnt/'])
    )
    expect(gitExecFileSyncMock).not.toHaveBeenCalled()
    expect(result.runnerScriptPath).toBe(
      String.raw`C:\src\app\.git\worktrees\fix\orca\setup-runner.sh`
    )
  })

  it('falls back to the host Git lookup when the link cannot be read', async () => {
    setLocalGitRuntimeRouter(() => 'Ubuntu')
    readWorktreeGitPathMock.mockReturnValueOnce(null)
    const result = await create()
    expect(gitExecFileSyncMock).toHaveBeenCalledOnce()
    expect(result.runnerScriptPath).toBe(String.raw`C:\src\app\.git\orca\setup-runner.sh`)
  })

  it('runs the host Git lookup main runs, with the router off', async () => {
    const result = await create()
    expect(readWorktreeGitPathMock).not.toHaveBeenCalled()
    expect(gitExecFileSyncMock).toHaveBeenCalledWith(
      ['rev-parse', '--git-path', 'orca/setup-runner.sh'],
      { cwd: WORKTREE, hostGit: true }
    )
    expect(result.runnerScriptPath).toBe(String.raw`C:\src\app\.git\orca\setup-runner.sh`)
  })
})
