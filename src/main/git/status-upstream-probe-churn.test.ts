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

import { getStatus } from './status'

describe('getStatus missing-upstream polling churn', () => {
  beforeEach(() => {
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

    const upstreamProbeCalls = gitExecFileAsyncMock.mock.calls.filter(
      ([args]: [string[]]) => args[0] === 'rev-parse' && args.includes('HEAD@{u}')
    )
    const sameNameOriginProbeCalls = gitExecFileAsyncMock.mock.calls.filter(
      ([args]: [string[]]) =>
        args[0] === 'rev-parse' && args.includes('refs/remotes/origin/Initi-Project')
    )

    expect(upstreamProbeCalls).toHaveLength(1)
    expect(sameNameOriginProbeCalls).toHaveLength(1)
  })
})
