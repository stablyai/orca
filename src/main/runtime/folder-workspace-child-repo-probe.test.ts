import { beforeEach, describe, expect, it, vi } from 'vitest'

const execNonInteractive = vi.fn()
const getSshGitProvider = vi.fn()

vi.mock('../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: (connectionId: string) => getSshGitProvider(connectionId),
  SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE: 'ssh git provider unavailable'
}))
vi.mock('../git/runner', () => ({ gitExecFileAsync: vi.fn() }))

import {
  assertChildRepoIndexReadable,
  probeChildRepoHasStagedChanges
} from './folder-workspace-child-repo-probe'
import type { RuntimeGitTarget } from './orca-runtime-git'

const TARGET = {
  worktree: { id: 'wt-1', path: '/remote/repo' },
  connectionId: 'ssh-1'
} as unknown as RuntimeGitTarget

function remoteResult(overrides: Record<string, unknown>): void {
  execNonInteractive.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '', ...overrides })
}

describe('probeChildRepoHasStagedChanges over SSH', () => {
  beforeEach(() => {
    execNonInteractive.mockReset()
    getSshGitProvider.mockReset()
    getSshGitProvider.mockReturnValue({ execNonInteractive })
  })

  it('reads rc 0 as nothing staged and rc 1 as staged', async () => {
    remoteResult({ exitCode: 0 })
    expect(await probeChildRepoHasStagedChanges(TARGET)).toBe(false)
    remoteResult({ exitCode: 1 })
    expect(await probeChildRepoHasStagedChanges(TARGET)).toBe(true)
  })

  it('runs the probe in the child repo, not the workspace container', async () => {
    remoteResult({ exitCode: 0 })
    await probeChildRepoHasStagedChanges(TARGET)
    expect(execNonInteractive).toHaveBeenCalledWith(
      'git',
      ['diff', '--cached', '--quiet'],
      '/remote/repo',
      expect.any(Number)
    )
  })

  // Why: these are the whole point of the module. A remote probe that cannot answer
  // must throw, because "false" here reads as "nothing staged" and hands the commit
  // to a different child repo — the silent partial-commit this design exists to stop.
  it('throws on a signal-killed probe rather than reading it as "nothing staged"', async () => {
    remoteResult({ exitCode: null, stderr: 'Killed' })
    await expect(probeChildRepoHasStagedChanges(TARGET)).rejects.toThrow('Killed')
  })

  it('throws on a timeout', async () => {
    remoteResult({ exitCode: null, timedOut: true })
    await expect(probeChildRepoHasStagedChanges(TARGET)).rejects.toThrow('timed out')
  })

  it('throws on a spawn error', async () => {
    remoteResult({ exitCode: null, spawnError: 'no such host' })
    await expect(probeChildRepoHasStagedChanges(TARGET)).rejects.toThrow('no such host')
  })

  it('throws a real git failure instead of treating it as an answer', async () => {
    remoteResult({ exitCode: 128, stderr: 'fatal: .git/index: index file smaller than expected' })
    await expect(probeChildRepoHasStagedChanges(TARGET)).rejects.toThrow('index file smaller')
  })

  it('throws when the connection has no provider', async () => {
    getSshGitProvider.mockReturnValue(undefined)
    await expect(probeChildRepoHasStagedChanges(TARGET)).rejects.toThrow(
      'ssh git provider unavailable'
    )
  })

  it('surfaces an unreadable remote index through the abort path too', async () => {
    remoteResult({ exitCode: 128, stderr: 'fatal: not a git repository' })
    await expect(assertChildRepoIndexReadable(TARGET)).rejects.toThrow('not a git repository')
  })
})
