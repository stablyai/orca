import { beforeEach, describe, expect, it, vi } from 'vitest'

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

describe('getStatus missing-upstream polling churn', () => {
  beforeEach(() => {
    clearEffectiveUpstreamStatusCacheForTests()
    existsSyncMock.mockReset()
    gitExecFileAsyncMock.mockReset()
    readFileMock.mockReset()
    existsSyncMock.mockReturnValue(false)
    readFileMock.mockResolvedValue('gitdir: /repo/.git/worktrees/Initi-Project\n')
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
      if (args[0] === 'config' && args.includes('branch.feature/fix.pushRemote')) {
        return { stdout: 'fork\n' }
      }
      if (args[0] === 'config' && args.includes('remote.pushDefault')) {
        throw new Error('missing pushDefault')
      }
      if (args[0] === 'config' && args.includes('branch.feature/fix.remote')) {
        return { stdout: 'fork\n' }
      }
      if (args[0] === 'config' && args.includes('branch.feature/fix.merge')) {
        return { stdout: 'refs/heads/feature/fix\n' }
      }
      if (args[0] === 'config' && args.includes('branch.feature/fix.base')) {
        throw new Error('missing branch base')
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
})
