import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Repro command:
//   pnpm exec vitest run --config config/vitest.config.ts src/main/git/status-upstream-probe-churn.test.ts -t "missing-upstream polling churn"

const { existsSyncMock, gitExecFileAsyncMock, readFileMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn(),
  gitExecFileAsyncMock: vi.fn(),
  readFileMock: vi.fn()
}))

vi.mock('./runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock,
  // Why: getStatus streams status output; forward args to the same mock so this
  // suite's arg-routing implementation still matches the status read.
  gitStreamStdout: async (
    args: string[],
    options: { onStdout: (chunk: string) => boolean | void }
  ) => {
    const { stdout } = await gitExecFileAsyncMock(args)
    const stoppedEarly = options.onStdout(stdout ?? '') === true
    return { stoppedEarly }
  },
  gitOptionalLocksDisabledEnv: (env: NodeJS.ProcessEnv = process.env) => ({
    ...env,
    GIT_OPTIONAL_LOCKS: '0'
  })
}))

vi.mock('fs/promises', () => ({
  readFile: readFileMock
}))

vi.mock('fs', () => ({
  existsSync: existsSyncMock
}))

import { clearEffectiveUpstreamStatusCacheForTests, getStatus } from './status'

function getGitArgs(call: unknown[]): string[] {
  return call[0] as string[]
}

function isConfigListSnapshotCommand(args: string[]): boolean {
  return args[0] === 'config' && args[1] === '--list' && args[2] === '-z'
}

function emptyGitConfigSnapshot(): { stdout: string } {
  return { stdout: 'core.repositoryformatversion\n0\0' }
}

function featureFixPushTargetSnapshot(): { stdout: string } {
  const records = [
    'branch.feature/fix.pushremote\nfork',
    'branch.feature/fix.remote\nfork',
    'branch.feature/fix.merge\nrefs/heads/feature/fix'
  ]
  return { stdout: `${records.join('\0')}\0` }
}

describe('getStatus missing-upstream polling churn', () => {
  beforeEach(() => {
    clearEffectiveUpstreamStatusCacheForTests()
    existsSyncMock.mockReset()
    gitExecFileAsyncMock.mockReset()
    readFileMock.mockReset()
    existsSyncMock.mockReturnValue(false)
    readFileMock.mockResolvedValue('gitdir: /repo/.git/worktrees/Initi-Project\n')
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not repeat failed effective-upstream probes for a branch with no upstream', async () => {
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args.includes('status')) {
        return {
          stdout: '# branch.oid abcdef1234567890\n# branch.head Initi-Project\n'
        }
      }
      if (args[0] === 'symbolic-ref' && args.includes('HEAD')) {
        return { stdout: 'Initi-Project\n' }
      }
      if (args[0] === 'rev-parse' && args.includes('HEAD@{u}')) {
        throw new Error("fatal: no upstream configured for branch 'Initi-Project'")
      }
      if (isConfigListSnapshotCommand(args)) {
        return emptyGitConfigSnapshot()
      }
      if (args[0] === 'rev-parse' && args.includes('refs/remotes/origin/Initi-Project')) {
        throw new Error('missing remote branch')
      }
      throw new Error(`unexpected git command: ${args.join(' ')}`)
    })

    await getStatus('/repo')
    await getStatus('/repo')
    await getStatus('/repo')

    const upstreamProbeCalls = gitExecFileAsyncMock.mock.calls.filter((call) => {
      const args = getGitArgs(call)
      return args[0] === 'rev-parse' && args.includes('HEAD@{u}')
    })
    const sameNameOriginProbeCalls = gitExecFileAsyncMock.mock.calls.filter((call) => {
      const args = getGitArgs(call)
      return args[0] === 'rev-parse' && args.includes('refs/remotes/origin/Initi-Project')
    })

    expect(upstreamProbeCalls).toHaveLength(1)
    expect(sameNameOriginProbeCalls).toHaveLength(1)
  })

  it('keeps failed effective-upstream probes cached beyond thirty seconds', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args.includes('status')) {
        return {
          stdout: '# branch.oid abcdef1234567890\n# branch.head Initi-Project\n'
        }
      }
      if (args[0] === 'symbolic-ref' && args.includes('HEAD')) {
        return { stdout: 'Initi-Project\n' }
      }
      if (args[0] === 'rev-parse' && args.includes('HEAD@{u}')) {
        throw new Error("fatal: no upstream configured for branch 'Initi-Project'")
      }
      if (isConfigListSnapshotCommand(args)) {
        return emptyGitConfigSnapshot()
      }
      if (args[0] === 'rev-parse' && args.includes('refs/remotes/origin/Initi-Project')) {
        throw new Error('missing remote branch')
      }
      throw new Error(`unexpected git command: ${args.join(' ')}`)
    })

    await getStatus('/repo')
    vi.setSystemTime(31_000)
    await getStatus('/repo')

    const upstreamProbeCalls = gitExecFileAsyncMock.mock.calls.filter((call) => {
      const args = getGitArgs(call)
      return args[0] === 'rev-parse' && args.includes('HEAD@{u}')
    })

    expect(upstreamProbeCalls).toHaveLength(1)
  })

  it('coalesces concurrent effective-upstream probes for a branch with no upstream', async () => {
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args.includes('status')) {
        return {
          stdout: '# branch.oid abcdef1234567890\n# branch.head Initi-Project\n'
        }
      }
      if (args[0] === 'symbolic-ref' && args.includes('HEAD')) {
        return { stdout: 'Initi-Project\n' }
      }
      if (args[0] === 'rev-parse' && args.includes('HEAD@{u}')) {
        await Promise.resolve()
        throw new Error("fatal: no upstream configured for branch 'Initi-Project'")
      }
      if (isConfigListSnapshotCommand(args)) {
        return emptyGitConfigSnapshot()
      }
      if (args[0] === 'rev-parse' && args.includes('refs/remotes/origin/Initi-Project')) {
        await Promise.resolve()
        throw new Error('missing remote branch')
      }
      throw new Error(`unexpected git command: ${args.join(' ')}`)
    })

    await Promise.all([getStatus('/repo'), getStatus('/repo'), getStatus('/repo')])

    const upstreamProbeCalls = gitExecFileAsyncMock.mock.calls.filter((call) => {
      const args = getGitArgs(call)
      return args[0] === 'rev-parse' && args.includes('HEAD@{u}')
    })
    const sameNameOriginProbeCalls = gitExecFileAsyncMock.mock.calls.filter((call) => {
      const args = getGitArgs(call)
      return args[0] === 'rev-parse' && args.includes('refs/remotes/origin/Initi-Project')
    })

    expect(upstreamProbeCalls).toHaveLength(1)
    expect(sameNameOriginProbeCalls).toHaveLength(1)
  })

  // The pushed-but-untracked branch shape (issue #7576): the effective
  // upstream resolves to the same-name origin ref, and before the resolved-name
  // cache each 3s poll re-ran the whole resolution chain (~5 spawns/tick).
  function mockResolvedSameNameOrigin(revList: { failOnCall?: number } = {}): void {
    let revListCalls = 0
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args.includes('status')) {
        return {
          stdout: '# branch.oid abcdef1234567890\n# branch.head bench/feature\n'
        }
      }
      if (args[0] === 'symbolic-ref' && args.includes('HEAD')) {
        return { stdout: 'bench/feature\n' }
      }
      if (args[0] === 'rev-parse' && args.includes('HEAD@{u}')) {
        throw new Error("fatal: no upstream configured for branch 'bench/feature'")
      }
      if (isConfigListSnapshotCommand(args)) {
        return emptyGitConfigSnapshot()
      }
      if (args[0] === 'rev-parse' && args.includes('refs/remotes/origin/bench/feature')) {
        return { stdout: 'abcdef1234567890\n' }
      }
      if (args[0] === 'rev-list') {
        revListCalls++
        if (revList.failOnCall === revListCalls) {
          throw new Error('fatal: bad revision')
        }
        return { stdout: '1\t0\n' }
      }
      throw new Error(`unexpected git command: ${args.join(' ')}`)
    })
  }

  function countCalls(predicate: (args: string[]) => boolean): number {
    return gitExecFileAsyncMock.mock.calls.filter((call) => predicate(getGitArgs(call))).length
  }

  it('revalidates a resolved same-name upstream with a single rev-list per poll', async () => {
    mockResolvedSameNameOrigin()

    await getStatus('/repo')
    await getStatus('/repo')
    await getStatus('/repo')

    // Resolution chain ran once; the two later polls paid one rev-list each.
    expect(countCalls((args) => args[0] === 'symbolic-ref')).toBe(1)
    expect(countCalls((args) => args[0] === 'rev-parse' && args.includes('HEAD@{u}'))).toBe(1)
    expect(countCalls(isConfigListSnapshotCommand)).toBe(1)
    expect(
      countCalls(
        (args) => args[0] === 'rev-parse' && args.includes('refs/remotes/origin/bench/feature')
      )
    ).toBe(1)
    expect(countCalls((args) => args[0] === 'rev-list')).toBe(3)
  })

  it('re-resolves the upstream after the resolved-name cache TTL lapses', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    mockResolvedSameNameOrigin()

    await getStatus('/repo')
    vi.setSystemTime(61_000)
    await getStatus('/repo')

    expect(countCalls((args) => args[0] === 'symbolic-ref')).toBe(2)
    expect(countCalls((args) => args[0] === 'rev-list')).toBe(2)
  })

  it('falls back to a full re-resolve when the cached upstream rev-list fails', async () => {
    // Second rev-list (the first revalidation attempt) fails, e.g. deleted ref.
    mockResolvedSameNameOrigin({ failOnCall: 2 })

    await getStatus('/repo')
    const status = await getStatus('/repo')

    // Full chain ran twice: initial resolve + the fallback after the failure.
    expect(countCalls((args) => args[0] === 'symbolic-ref')).toBe(2)
    // rev-list: initial + failed revalidate + fallback's own rev-list.
    expect(countCalls((args) => args[0] === 'rev-list')).toBe(3)
    expect(status.upstreamStatus?.hasUpstream).toBe(true)
  })

  it('does not cache a positive configured push target signal', async () => {
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args.includes('status')) {
        return {
          stdout: '# branch.oid abcdef1234567890\n# branch.head feature/fix\n'
        }
      }
      if (args[0] === 'symbolic-ref' && args.includes('HEAD')) {
        return { stdout: 'feature/fix\n' }
      }
      if (args[0] === 'rev-parse' && args.includes('HEAD@{u}')) {
        throw new Error("fatal: no upstream configured for branch 'feature/fix'")
      }
      if (isConfigListSnapshotCommand(args)) {
        return featureFixPushTargetSnapshot()
      }
      if (args[0] === 'rev-parse' && args.some((arg) => arg.startsWith('refs/remotes/'))) {
        throw new Error('missing remote branch')
      }
      throw new Error(`unexpected git command: ${args.join(' ')}`)
    })

    await getStatus('/repo')
    await getStatus('/repo')

    const upstreamProbeCalls = gitExecFileAsyncMock.mock.calls.filter((call) => {
      const args = getGitArgs(call)
      return args[0] === 'rev-parse' && args.includes('HEAD@{u}')
    })

    expect(upstreamProbeCalls).toHaveLength(2)
  })

  it('rechecks failed effective-upstream probes after the branch identity changes', async () => {
    let nextBranch = 'Second-Project'
    let currentStatusBranch = nextBranch
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args.includes('status')) {
        currentStatusBranch = nextBranch
        nextBranch = 'Other-Project'
        return {
          stdout: `# branch.oid abcdef1234567890\n# branch.head ${currentStatusBranch}\n`
        }
      }
      if (args[0] === 'symbolic-ref' && args.includes('HEAD')) {
        return { stdout: `${currentStatusBranch}\n` }
      }
      if (args[0] === 'rev-parse' && args.includes('HEAD@{u}')) {
        throw new Error('fatal: no upstream configured')
      }
      if (isConfigListSnapshotCommand(args)) {
        return emptyGitConfigSnapshot()
      }
      if (args[0] === 'rev-parse' && args.some((arg) => arg.startsWith('refs/remotes/origin/'))) {
        throw new Error('missing remote branch')
      }
      throw new Error(`unexpected git command: ${args.join(' ')}`)
    })

    await getStatus('/repo')
    await getStatus('/repo')

    const sameNameOriginProbeCalls = gitExecFileAsyncMock.mock.calls.filter((call) => {
      const args = getGitArgs(call)
      return args[0] === 'rev-parse' && args.some((arg) => arg.startsWith('refs/remotes/origin/'))
    })

    expect(sameNameOriginProbeCalls.map((call) => getGitArgs(call).at(-1))).toEqual([
      'refs/remotes/origin/Second-Project',
      'refs/remotes/origin/Other-Project'
    ])
  })

  it('coalesces no-upstream config reads into one snapshot subprocess', async () => {
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args.includes('status')) {
        return {
          stdout: '# branch.oid abcdef1234567890\n# branch.head Initi-Project\n'
        }
      }
      if (args[0] === 'symbolic-ref' && args.includes('HEAD')) {
        return { stdout: 'Initi-Project\n' }
      }
      if (args[0] === 'rev-parse' && args.includes('HEAD@{u}')) {
        throw new Error("fatal: no upstream configured for branch 'Initi-Project'")
      }
      if (isConfigListSnapshotCommand(args)) {
        return emptyGitConfigSnapshot()
      }
      if (args[0] === 'rev-parse' && args.includes('refs/remotes/origin/Initi-Project')) {
        throw new Error('missing remote branch')
      }
      throw new Error(`unexpected git command: ${args.join(' ')}`)
    })

    const status = await getStatus('/repo')

    const configListCalls = gitExecFileAsyncMock.mock.calls.filter((call) =>
      isConfigListSnapshotCommand(getGitArgs(call))
    )
    const configGetCalls = gitExecFileAsyncMock.mock.calls.filter((call) => {
      const args = getGitArgs(call)
      return args[0] === 'config' && args[1] === '--get'
    })

    expect(configListCalls).toHaveLength(1)
    expect(configGetCalls).toHaveLength(0)
    if (!status.upstreamStatus) {
      throw new Error('expected upstream status')
    }
    expect(status.upstreamStatus.hasUpstream).toBe(false)
  })
})
