import { beforeEach, describe, expect, it, vi } from 'vitest'

const { existsSyncMock, gitExecFileAsyncMock, readFileMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn(),
  gitExecFileAsyncMock: vi.fn(),
  readFileMock: vi.fn()
}))

vi.mock('./runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock,
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

import {
  clearEffectiveUpstreamNegativeStatusCache,
  clearEffectiveUpstreamStatusCacheForTests,
  getEffectiveUpstreamStatusCacheCountForTests,
  getEffectiveUpstreamStatusGenerationCountForTests,
  getStatus
} from './status'

describe('local upstream negative cache', () => {
  beforeEach(() => {
    clearEffectiveUpstreamStatusCacheForTests()
    existsSyncMock.mockReset()
    gitExecFileAsyncMock.mockReset()
    readFileMock.mockReset()
    existsSyncMock.mockReturnValue(false)
    readFileMock.mockResolvedValue('gitdir: /repo/.git/worktrees/feature\n')
  })

  it('bypasses a cached negative result for strict status reads', async () => {
    let originBranchExists = false
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args.includes('status')) {
        return {
          stdout: '# branch.oid abcdef1234567890\n# branch.head feature\n'
        }
      }
      if (args[0] === 'symbolic-ref' && args.includes('HEAD')) {
        return { stdout: 'feature\n' }
      }
      if (args[0] === 'rev-parse' && args.includes('HEAD@{u}')) {
        throw new Error('fatal: no upstream configured for branch feature')
      }
      if (args[0] === 'rev-parse' && args.includes('refs/remotes/origin/feature')) {
        if (originBranchExists) {
          return { stdout: 'abc123\n' }
        }
        throw new Error('missing remote branch')
      }
      if (args[0] === 'rev-list' && args.includes('HEAD...origin/feature')) {
        return { stdout: '0\t1\n' }
      }
      throw new Error(`unexpected git command: ${args.join(' ')}`)
    })

    const first = await getStatus('/repo')
    originBranchExists = true
    const automatic = await getStatus('/repo')
    const strict = await getStatus('/repo', { bypassEffectiveUpstreamNegativeCache: true })

    expect(first.upstreamStatus).toEqual({ hasUpstream: false, ahead: 0, behind: 0 })
    expect(automatic.upstreamStatus).toEqual(first.upstreamStatus)
    expect(strict.upstreamStatus).toEqual({
      hasUpstream: true,
      upstreamName: 'origin/feature',
      ahead: 0,
      behind: 1
    })
  })

  it('keeps an older automatic negative probe from overwriting a strict positive result', async () => {
    let originBranchExists = false
    let deferredOriginReject: ((error: Error) => void) | null = null
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args.includes('status')) {
        return {
          stdout: '# branch.oid abcdef1234567890\n# branch.head feature\n'
        }
      }
      if (args[0] === 'symbolic-ref' && args.includes('HEAD')) {
        return { stdout: 'feature\n' }
      }
      if (args[0] === 'rev-parse' && args.includes('HEAD@{u}')) {
        throw new Error('fatal: no upstream configured for branch feature')
      }
      if (args[0] === 'rev-parse' && args.includes('refs/remotes/origin/feature')) {
        if (originBranchExists) {
          return { stdout: 'abc123\n' }
        }
        return await new Promise<{ stdout: string }>((_, reject) => {
          deferredOriginReject = reject
        })
      }
      if (args[0] === 'rev-list' && args.includes('HEAD...origin/feature')) {
        return { stdout: '0\t1\n' }
      }
      throw new Error(`unexpected git command: ${args.join(' ')}`)
    })

    const automatic = getStatus('/repo')
    await vi.waitFor(() => expect(deferredOriginReject).toBeTruthy())

    originBranchExists = true
    const strict = await getStatus('/repo', { bypassEffectiveUpstreamNegativeCache: true })
    if (!deferredOriginReject) {
      throw new Error('expected deferred origin reject')
    }
    ;(deferredOriginReject as (error: Error) => void)(new Error('missing remote branch'))
    const staleAutomatic = await automatic
    const nextAutomatic = await getStatus('/repo')

    expect(strict.upstreamStatus).toEqual({
      hasUpstream: true,
      upstreamName: 'origin/feature',
      ahead: 0,
      behind: 1
    })
    expect(staleAutomatic.upstreamStatus).toEqual({ hasUpstream: false, ahead: 0, behind: 0 })
    expect(nextAutomatic.upstreamStatus).toEqual(strict.upstreamStatus)
  })

  it('does not trim generation for an unresolved automatic probe', async () => {
    let originBranchExists = false
    let deferredOriginReject: ((error: Error) => void) | null = null
    const branchQueue = [
      'feature',
      'feature',
      ...Array.from({ length: 512 }, (_, index) => `other-${index}`),
      'feature'
    ]
    let currentBranch = 'feature'
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args.includes('status')) {
        currentBranch = branchQueue.shift() ?? currentBranch
        return {
          stdout: `# branch.oid abcdef1234567890\n# branch.head ${currentBranch}\n`
        }
      }
      if (args[0] === 'symbolic-ref' && args.includes('HEAD')) {
        return { stdout: `${currentBranch}\n` }
      }
      if (args[0] === 'rev-parse' && args.includes('HEAD@{u}')) {
        throw new Error(`fatal: no upstream configured for branch ${currentBranch}`)
      }
      if (args[0] === 'rev-parse' && args.some((arg) => arg.startsWith('refs/remotes/origin/'))) {
        if (originBranchExists) {
          return { stdout: 'abc123\n' }
        }
        return await new Promise<{ stdout: string }>((_, reject) => {
          deferredOriginReject = reject
        })
      }
      if (args[0] === 'rev-list' && args.some((arg) => arg.startsWith('HEAD...origin/'))) {
        return { stdout: '0\t1\n' }
      }
      throw new Error(`unexpected git command: ${args.join(' ')}`)
    })

    const automatic = getStatus('/repo')
    await vi.waitFor(() => expect(deferredOriginReject).toBeTruthy())

    originBranchExists = true
    const strict = await getStatus('/repo', { bypassEffectiveUpstreamNegativeCache: true })
    for (let index = 0; index < 512; index += 1) {
      await getStatus('/repo', { bypassEffectiveUpstreamNegativeCache: true })
    }
    if (!deferredOriginReject) {
      throw new Error('expected deferred origin reject')
    }
    ;(deferredOriginReject as (error: Error) => void)(new Error('missing remote branch'))
    await automatic
    const nextAutomatic = await getStatus('/repo')

    expect(strict.upstreamStatus).toEqual({
      hasUpstream: true,
      upstreamName: 'origin/feature',
      ahead: 0,
      behind: 1
    })
    expect(nextAutomatic.upstreamStatus).toEqual(strict.upstreamStatus)
    expect(getEffectiveUpstreamStatusGenerationCountForTests()).toBeLessThanOrEqual(512)
  })

  it('does not trim generation for a cleared automatic probe before it settles', async () => {
    let originBranchExists = false
    let deferredOriginReject: ((error: Error) => void) | null = null
    const branchQueue = [
      'feature',
      ...Array.from({ length: 512 }, (_, index) => `other-${index}`),
      'feature'
    ]
    let currentBranch = 'feature'
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args.includes('status')) {
        currentBranch = branchQueue.shift() ?? currentBranch
        return {
          stdout: `# branch.oid abcdef1234567890\n# branch.head ${currentBranch}\n`
        }
      }
      if (args[0] === 'symbolic-ref' && args.includes('HEAD')) {
        return { stdout: `${currentBranch}\n` }
      }
      if (args[0] === 'rev-parse' && args.includes('HEAD@{u}')) {
        throw new Error(`fatal: no upstream configured for branch ${currentBranch}`)
      }
      if (args[0] === 'rev-parse' && args.some((arg) => arg.startsWith('refs/remotes/origin/'))) {
        if (originBranchExists) {
          return { stdout: 'abc123\n' }
        }
        return await new Promise<{ stdout: string }>((_, reject) => {
          deferredOriginReject = reject
        })
      }
      if (args[0] === 'rev-list' && args.some((arg) => arg.startsWith('HEAD...origin/'))) {
        return { stdout: '0\t1\n' }
      }
      throw new Error(`unexpected git command: ${args.join(' ')}`)
    })

    const automatic = getStatus('/repo')
    await vi.waitFor(() => expect(deferredOriginReject).toBeTruthy())

    originBranchExists = true
    clearEffectiveUpstreamNegativeStatusCache({ worktreePath: '/repo', branchName: 'feature' })
    for (let index = 0; index < 512; index += 1) {
      await getStatus('/repo', { bypassEffectiveUpstreamNegativeCache: true })
    }
    if (!deferredOriginReject) {
      throw new Error('expected deferred origin reject')
    }
    ;(deferredOriginReject as (error: Error) => void)(new Error('missing remote branch'))
    await automatic
    const nextAutomatic = await getStatus('/repo')

    expect(nextAutomatic.upstreamStatus).toEqual({
      hasUpstream: true,
      upstreamName: 'origin/feature',
      ahead: 0,
      behind: 1
    })
    expect(getEffectiveUpstreamStatusGenerationCountForTests()).toBeLessThanOrEqual(512)
  })

  it('bounds effective-upstream negative entries', async () => {
    let branchIndex = 0
    let currentBranch = 'feature-0'
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args.includes('status')) {
        currentBranch = `feature-${branchIndex}`
        branchIndex += 1
        return {
          stdout: `# branch.oid abcdef1234567890\n# branch.head ${currentBranch}\n`
        }
      }
      if (args[0] === 'symbolic-ref' && args.includes('HEAD')) {
        return { stdout: `${currentBranch}\n` }
      }
      if (args[0] === 'rev-parse' && args.includes('HEAD@{u}')) {
        throw new Error(`fatal: no upstream configured for branch ${currentBranch}`)
      }
      if (args[0] === 'rev-parse' && args.some((arg) => arg.startsWith('refs/remotes/origin/'))) {
        throw new Error('missing remote branch')
      }
      throw new Error(`unexpected git command: ${args.join(' ')}`)
    })

    for (let index = 0; index < 513; index += 1) {
      await getStatus('/repo')
    }

    expect(getEffectiveUpstreamStatusCacheCountForTests()).toBe(512)
    expect(getEffectiveUpstreamStatusGenerationCountForTests()).toBeLessThanOrEqual(512)
  })

  it('bounds write-generation entries from positive strict probes', async () => {
    let branchIndex = 0
    let currentBranch = 'feature-0'
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args.includes('status')) {
        currentBranch = `feature-${branchIndex}`
        branchIndex += 1
        return {
          stdout: `# branch.oid abcdef1234567890\n# branch.head ${currentBranch}\n`
        }
      }
      if (args[0] === 'symbolic-ref' && args.includes('HEAD')) {
        return { stdout: `${currentBranch}\n` }
      }
      if (args[0] === 'rev-parse' && args.includes('HEAD@{u}')) {
        throw new Error(`fatal: no upstream configured for branch ${currentBranch}`)
      }
      if (args[0] === 'rev-parse' && args.includes(`refs/remotes/origin/${currentBranch}`)) {
        return { stdout: 'abc123\n' }
      }
      if (args[0] === 'rev-list' && args.includes(`HEAD...origin/${currentBranch}`)) {
        return { stdout: '0\t1\n' }
      }
      throw new Error(`unexpected git command: ${args.join(' ')}`)
    })

    for (let index = 0; index < 513; index += 1) {
      await getStatus('/repo', { bypassEffectiveUpstreamNegativeCache: true })
    }

    expect(getEffectiveUpstreamStatusCacheCountForTests()).toBe(0)
    expect(getEffectiveUpstreamStatusGenerationCountForTests()).toBe(512)
  })
})
