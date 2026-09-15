import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type * as HooksModule from '../../../hooks'

const { getSshFilesystemProviderMock, getEffectiveHooksMock, requireSshGitProviderMock } =
  vi.hoisted(() => ({
    getSshFilesystemProviderMock: vi.fn(),
    getEffectiveHooksMock: vi.fn(),
    requireSshGitProviderMock: vi.fn()
  }))
vi.mock('../../../providers/ssh-filesystem-dispatch', () => ({
  getSshFilesystemProvider: getSshFilesystemProviderMock
}))
vi.mock('../../../providers/ssh-git-dispatch', () => ({
  requireSshGitProvider: requireSshGitProviderMock
}))
// Only `getEffectiveHooks` is stubbed: the module under test also imports `parseOrcaYaml` from
// here, and replacing it wholesale made the parse throw into the fail-open catch — which answers
// "no hook", so the test saw an empty result rather than an error.
vi.mock('../../../hooks', async () => ({
  ...(await vi.importActual<typeof HooksModule>('../../../hooks')),
  getEffectiveHooks: getEffectiveHooksMock
}))

import { getArchiveHooksForRemoval, runRemoteArchiveHook } from './worktree-archive-hook'

const REMOTE_REPO: Repo = {
  id: 'r',
  path: '/home/orca/repo',
  displayName: 'r',
  badgeColor: '#000',
  addedAt: 0
}

// Why (#19334): a worktree row can name its owner only as `executionHostId: 'ssh:<target>'`, leaving
// `repo.connectionId` null. Resolving hooks off the row alone then reads THIS machine's disk for a
// repo that lives on an SSH host — the committed archive hook goes unseen and the removal proceeds
// as though none were configured, which is the bug the gate exists to stop.
describe('getArchiveHooksForRemoval owner resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getSshFilesystemProviderMock.mockReturnValue(undefined)
    getEffectiveHooksMock.mockReturnValue(null)
  })

  // Why this reads a file rather than just checking the lookup key: SSH owner resolution has been
  // wrong twice on this path, and both times the fix looked right. Asserting only that
  // `'ssh-target'` was passed stops short of the thing that broke — whether the hook actually comes
  // from the REMOTE orca.yaml. This drives a stubbed provider holding real content and asserts the
  // returned script is the remote one.
  it('returns the hook from the execution host\u2019s orca.yaml, not the local disk', async () => {
    const readFile = vi.fn().mockResolvedValue({
      isBinary: false,
      content: 'scripts:\n  archive: remote-archive.sh\n'
    })
    getSshFilesystemProviderMock.mockReturnValue({ readFile })
    // If the local reader were consulted it would answer with a DIFFERENT script, so a wrong
    // resolution shows up as the wrong value rather than as a silent absence.
    getEffectiveHooksMock.mockReturnValue({ scripts: { archive: 'local-archive.sh' } })

    const hooks = await getArchiveHooksForRemoval(REMOTE_REPO, 'ssh-target')

    expect(getSshFilesystemProviderMock).toHaveBeenCalledWith('ssh-target')
    expect(readFile).toHaveBeenCalledWith('/home/orca/repo/orca.yaml')
    expect(hooks?.scripts.archive).toBe('remote-archive.sh')
    expect(getEffectiveHooksMock).not.toHaveBeenCalled()
  })

  it('falls back to the repo row when the caller names no owner', async () => {
    await getArchiveHooksForRemoval({ ...REMOTE_REPO, connectionId: 'row-connection' })

    expect(getSshFilesystemProviderMock).toHaveBeenCalledWith('row-connection')
    expect(getEffectiveHooksMock).not.toHaveBeenCalled()
  })

  it('reads locally only when neither names a connection', async () => {
    await getArchiveHooksForRemoval({ ...REMOTE_REPO, path: '/local/repo' })

    expect(getSshFilesystemProviderMock).not.toHaveBeenCalled()
    expect(getEffectiveHooksMock).toHaveBeenCalled()
  })

  // Known limitation, pinned so it is a decision rather than a surprise: the relay rewrites a
  // non-numeric error code to -32000, so a missing orca.yaml and an unreachable host arrive
  // identically. Both answer "no hook", which lets the removal proceed. Reporting them apart needs
  // a provider contract that returns absence as a successful outcome — tracked in #20196.
  it('answers "no hook" when the host cannot be read, missing or unreachable alike', async () => {
    getSshFilesystemProviderMock.mockReturnValue({
      readFile: vi.fn().mockRejectedValue(
        Object.assign(new Error('transport closed'), {
          code: -32000
        })
      )
    })

    await expect(getArchiveHooksForRemoval(REMOTE_REPO, 'ssh-target')).resolves.toEqual(null)
  })
})

describe('runRemoteArchiveHook', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireSshGitProviderMock.mockReset()
  })

  it('runs through the explicitly named provider when the repo has no connectionId', async () => {
    const execNonInteractive = vi.fn().mockResolvedValue({
      stdout: 'archived',
      stderr: '',
      exitCode: 0,
      timedOut: false
    })
    requireSshGitProviderMock.mockImplementation((connectionId: string) => {
      if (connectionId === 'ssh-target') {
        return { execNonInteractive }
      }
      return undefined
    })

    const result = await runRemoteArchiveHook(
      REMOTE_REPO,
      'ssh-target',
      '/home/orca/repo/worktree',
      'archive.sh'
    )

    expect(requireSshGitProviderMock).toHaveBeenCalledWith('ssh-target')
    expect(result).toEqual({ success: true, output: 'archived', exitCode: 0 })
  })

  it('retains a numeric non-zero exit code in the failed result', async () => {
    requireSshGitProviderMock.mockReturnValue({
      execNonInteractive: vi.fn().mockResolvedValue({
        stdout: '',
        stderr: 'archive failed',
        exitCode: 7,
        timedOut: false
      })
    })

    const result = await runRemoteArchiveHook(
      REMOTE_REPO,
      'ssh-target',
      '/home/orca/repo/worktree',
      'archive.sh'
    )

    expect(result).toEqual({
      success: false,
      output: 'archive failed\narchive hook exited 7',
      exitCode: 7
    })
  })

  it('omits the exit code when the hook times out', async () => {
    requireSshGitProviderMock.mockReturnValue({
      execNonInteractive: vi.fn().mockResolvedValue({
        stdout: 'partial output',
        stderr: '',
        exitCode: null,
        timedOut: true
      })
    })

    const result = await runRemoteArchiveHook(
      REMOTE_REPO,
      'ssh-target',
      '/home/orca/repo/worktree',
      'archive.sh'
    )

    expect(result).toEqual({
      success: false,
      output: 'partial output\narchive hook timed out'
    })
  })

  it('omits the exit code when the hook cannot spawn', async () => {
    requireSshGitProviderMock.mockReturnValue({
      execNonInteractive: vi.fn().mockRejectedValue(new Error('spawn failed'))
    })

    const result = await runRemoteArchiveHook(
      REMOTE_REPO,
      'ssh-target',
      '/home/orca/repo/worktree',
      'archive.sh'
    )

    expect(result).toEqual({ success: false, output: 'spawn failed' })
  })
})
