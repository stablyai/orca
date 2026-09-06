import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeFs from 'node:fs'
import path from 'node:path'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn()
}))

vi.mock('./runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock
}))

import { getUpstreamStatus, invalidateGitUpstreamStatusReads } from './upstream'
import { runWithGitReadCacheInvalidation } from './status'

const missingTrackingRefError = new Error(
  "fatal: ambiguous argument 'HEAD@{u}': unknown revision or path not in the working tree.\n" +
    "Use '--' to separate paths from revisions, like this:\n" +
    "'git <command> [<revision>...] -- [<file>...]'"
)

describe('getUpstreamStatus', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    invalidateGitUpstreamStatusReads()
  })

  it('benchmarks concurrent upstream Git command pressure', async () => {
    const benchPath = process.env.ORCA_GIT_UPSTREAM_COALESCING_BENCH_JSON
    if (!benchPath) {
      return
    }
    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      if (args[0] === 'symbolic-ref') {
        return Promise.resolve({ stdout: 'main\n' })
      }
      if (args[0] === 'rev-parse') {
        return Promise.resolve({ stdout: 'origin/main\n' })
      }
      if (args[0] === 'rev-list') {
        return Promise.resolve({ stdout: '2\t3\n' })
      }
      if (args[0] === 'log') {
        return Promise.resolve({ stdout: '+ abc123 remote work\n' })
      }
      throw new Error(`unexpected git args: ${args.join(' ')}`)
    })

    await Promise.all(Array.from({ length: 10 }, () => getUpstreamStatus('/repo')))

    const commands = gitExecFileAsyncMock.mock.calls.map(([args, options]) => ({ args, options }))
    const commandCounts = Object.fromEntries(
      ['symbolic-ref', 'rev-parse', 'rev-list', 'log'].map((command) => [
        command,
        commands.filter(({ args }) => args[0] === command).length
      ])
    )
    const { mkdirSync, writeFileSync } = await vi.importActual<typeof NodeFs>('node:fs')
    mkdirSync(path.dirname(benchPath), { recursive: true })
    writeFileSync(
      benchPath,
      JSON.stringify({
        scenario: 'local-git-upstream-concurrent-burst',
        concurrentCalls: 10,
        physicalGitCalls: commands.length,
        commandCounts,
        commandChain: ['symbolic-ref', 'rev-parse', 'rev-list', 'log'].map((command) =>
          commands.find(({ args }) => args[0] === command)
        )
      })
    )
  })

  // Why: the benchmark above only runs under an env var, so this is the CI-enforced
  // guard that the native/WSL path actually coalesces rather than fanning out.
  it('shares one physical read across ten identical native callers', async () => {
    let resolveSymbolicRef = (): void => {}
    const symbolicRefGate = new Promise<void>((resolve) => {
      resolveSymbolicRef = resolve
    })
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'symbolic-ref') {
        await symbolicRefGate
        return { stdout: 'main\n' }
      }
      if (args[0] === 'rev-parse') {
        return { stdout: 'origin/main\n' }
      }
      if (args[0] === 'rev-list') {
        return { stdout: '0\t0\n' }
      }
      throw new Error(`unexpected git args: ${args.join(' ')}`)
    })

    const reads = Array.from({ length: 10 }, () => getUpstreamStatus('/repo'))
    resolveSymbolicRef()
    const results = await Promise.all(reads)

    expect(
      gitExecFileAsyncMock.mock.calls.filter(([args]) => args[0] === 'symbolic-ref')
    ).toHaveLength(1)
    expect(new Set(results).size).toBe(1)
    // A settled lease is dropped, so the next read must issue fresh Git work.
    await getUpstreamStatus('/repo')
    expect(
      gitExecFileAsyncMock.mock.calls.filter(([args]) => args[0] === 'symbolic-ref')
    ).toHaveLength(2)
  })

  it('isolates physical reads by worktree, native or WSL host, and every target field', async () => {
    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      if (args[0] === 'symbolic-ref') {
        return Promise.resolve({ stdout: 'main\n' })
      }
      if (args[0] === 'check-ref-format') {
        return Promise.resolve({ stdout: '' })
      }
      if (args[0] === 'rev-parse' && args.includes('HEAD@{u}')) {
        return Promise.resolve({ stdout: 'origin/main\n' })
      }
      if (args[0] === 'rev-parse' && args.includes('--verify')) {
        return Promise.resolve({ stdout: 'abc123\n' })
      }
      if (args[0] === 'rev-list') {
        return Promise.resolve({ stdout: '0\t0\n' })
      }
      throw new Error(`unexpected git args: ${args.join(' ')}`)
    })
    const baseTarget = { remoteName: 'fork', branchName: 'feature' }

    await Promise.all([
      getUpstreamStatus('/repo-a'),
      getUpstreamStatus('/repo-b'),
      getUpstreamStatus('/repo-a', undefined, { wslDistro: 'Ubuntu' }),
      getUpstreamStatus('/repo-a', undefined, { wslDistro: 'Debian' }),
      getUpstreamStatus('/repo-a', baseTarget),
      getUpstreamStatus('/repo-a', { ...baseTarget, remoteName: 'origin' }),
      getUpstreamStatus('/repo-a', { ...baseTarget, branchName: 'other' }),
      getUpstreamStatus('/repo-a', {
        ...baseTarget,
        remoteUrl: 'https://github.com/example/fork.git'
      }),
      getUpstreamStatus('/repo-a', { ...baseTarget, remoteCreated: false }),
      getUpstreamStatus('/repo-a', { ...baseTarget, remoteCreated: true })
    ])

    expect(
      gitExecFileAsyncMock.mock.calls.filter(([args]) => args[0] === 'symbolic-ref')
    ).toHaveLength(4)
    expect(
      gitExecFileAsyncMock.mock.calls.filter(([args]) => args[0] === 'check-ref-format')
    ).toHaveLength(6)
  })

  it('runs fresh physical work after a normalized rejection', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'main\n' })
      .mockResolvedValueOnce({ stdout: 'origin/main\n' })
      .mockRejectedValueOnce(new Error('fatal: authentication failed'))
      .mockResolvedValueOnce({ stdout: 'main\n' })
      .mockResolvedValueOnce({ stdout: 'origin/main\n' })
      .mockResolvedValueOnce({ stdout: '0\t0\n' })

    await expect(getUpstreamStatus('/repo')).rejects.toThrow('fatal: authentication failed')
    await expect(getUpstreamStatus('/repo')).resolves.toMatchObject({
      hasUpstream: true,
      upstreamName: 'origin/main'
    })
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(6)
  })

  it('uses the common pre/post mutation fence for physical upstream reads', async () => {
    const pendingReads: {
      promise: Promise<{ stdout: string }>
      resolve: (value: { stdout: string }) => void
    }[] = []
    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      if (args[0] === 'symbolic-ref') {
        let resolve!: (value: { stdout: string }) => void
        const promise = new Promise<{ stdout: string }>((innerResolve) => {
          resolve = innerResolve
        })
        pendingReads.push({ promise, resolve })
        return promise
      }
      if (args[0] === 'rev-parse') {
        return Promise.resolve({ stdout: 'origin/main\n' })
      }
      if (args[0] === 'rev-list') {
        return Promise.resolve({ stdout: '0\t0\n' })
      }
      throw new Error(`unexpected git args: ${args.join(' ')}`)
    })
    let finishMutation!: () => void
    const mutationGate = new Promise<void>((resolve) => {
      finishMutation = resolve
    })

    const before = getUpstreamStatus('/repo')
    await vi.waitFor(() => expect(pendingReads).toHaveLength(1))
    const mutation = runWithGitReadCacheInvalidation(() => mutationGate)
    const during = getUpstreamStatus('/repo')
    await vi.waitFor(() => expect(pendingReads).toHaveLength(2))
    finishMutation()
    await mutation
    const after = getUpstreamStatus('/repo')
    await vi.waitFor(() => expect(pendingReads).toHaveLength(3))

    pendingReads.forEach(({ resolve }) => resolve({ stdout: 'main\n' }))
    await Promise.all([before, during, after])
    expect(pendingReads).toHaveLength(3)
  })

  it('returns upstream and ahead/behind counts when tracking is configured', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'main\n' })
      .mockResolvedValueOnce({ stdout: 'origin/main\n' })
      .mockResolvedValueOnce({ stdout: '2\t3\n' })
      .mockResolvedValueOnce({ stdout: '+ abc123 remote work\n' })

    const result = await getUpstreamStatus('/repo')

    expect(result).toEqual({
      hasUpstream: true,
      upstreamName: 'origin/main',
      ahead: 2,
      behind: 3,
      behindCommitsArePatchEquivalent: false
    })
  })

  it('marks diverged upstream commits as patch-equivalent after a rebase', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'feature\n' })
      .mockResolvedValueOnce({ stdout: 'origin/feature\n' })
      .mockResolvedValueOnce({ stdout: '14\t3\n' })
      .mockResolvedValueOnce({
        stdout:
          '= ac503deae Stabilize pull request creation flow\n' +
          '= 7dc0fc1a6 Clean up fork PR remotes after worktree deletion\n'
      })

    const result = await getUpstreamStatus('/repo')

    expect(result).toEqual({
      hasUpstream: true,
      upstreamName: 'origin/feature',
      ahead: 14,
      behind: 3,
      behindCommitsArePatchEquivalent: true
    })
  })

  it('keeps configured local-branch upstreams', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'feature\n' })
      .mockResolvedValueOnce({ stdout: 'main\n' })
      .mockResolvedValueOnce({ stdout: '1\t0\n' })

    const result = await getUpstreamStatus('/repo')

    expect(result).toEqual({
      hasUpstream: true,
      upstreamName: 'main',
      ahead: 1,
      behind: 0
    })
  })

  it('returns hasUpstream=false when upstream output is empty', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'feature\n' })
      .mockResolvedValueOnce({ stdout: '\n' })
      .mockRejectedValueOnce(new Error('missing branch remote'))
      .mockRejectedValueOnce(new Error('missing branch merge'))
      .mockRejectedValueOnce(new Error('missing branch base'))
      .mockRejectedValueOnce(new Error('missing remote branch'))

    const result = await getUpstreamStatus('/repo')

    expect(result).toEqual({
      hasUpstream: false,
      ahead: 0,
      behind: 0
    })
  })

  it('returns hasUpstream=false when upstream is missing', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'feature\n' })
      .mockRejectedValueOnce(new Error('fatal: no upstream configured'))
      .mockRejectedValueOnce(new Error('missing branch remote'))
      .mockRejectedValueOnce(new Error('missing branch merge'))
      .mockRejectedValueOnce(new Error('missing branch base'))
      .mockRejectedValueOnce(new Error('missing remote branch'))

    const result = await getUpstreamStatus('/repo')

    expect(result).toEqual({
      hasUpstream: false,
      ahead: 0,
      behind: 0
    })
  })

  it('returns hasUpstream=false when the configured tracking ref is missing', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'feature\n' })
      .mockRejectedValueOnce(missingTrackingRefError)
      .mockRejectedValueOnce(new Error('missing branch remote'))
      .mockRejectedValueOnce(new Error('missing branch merge'))
      .mockRejectedValueOnce(new Error('missing branch base'))
      .mockRejectedValueOnce(new Error('missing remote branch'))

    const result = await getUpstreamStatus('/repo')

    expect(result).toEqual({
      hasUpstream: false,
      ahead: 0,
      behind: 0
    })
  })

  it('uses the same-name origin branch when a legacy worktree tracks origin/main', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'feature\n' })
      .mockResolvedValueOnce({ stdout: 'origin/main\n' })
      .mockResolvedValueOnce({ stdout: 'abc123\n' })
      .mockResolvedValueOnce({ stdout: '3\t1\n' })
      .mockResolvedValueOnce({ stdout: '+ def456 remote work\n' })

    const result = await getUpstreamStatus('/repo')

    expect(result).toEqual({
      hasUpstream: true,
      upstreamName: 'origin/feature',
      ahead: 3,
      behind: 1,
      behindCommitsArePatchEquivalent: false
    })
  })

  it('uses a named remote that matches a URL-valued branch remote', async () => {
    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      if (args[0] === 'symbolic-ref') {
        return Promise.resolve({ stdout: 'imp/chinese-translation\n' })
      }
      if (args[0] === 'rev-parse' && args.includes('HEAD@{u}')) {
        return Promise.reject(new Error('fatal: no upstream configured'))
      }
      if (args[0] === 'config' && args.includes('branch.imp/chinese-translation.remote')) {
        return Promise.resolve({ stdout: 'https://github.com/pynickle/orca.git\n' })
      }
      if (args[0] === 'config' && args.includes('branch.imp/chinese-translation.merge')) {
        return Promise.resolve({ stdout: 'refs/heads/imp/chinese-translation\n' })
      }
      if (args[0] === 'config' && args.includes('branch.imp/chinese-translation.base')) {
        return Promise.reject(new Error('missing branch base'))
      }
      if (args[0] === 'remote' && args[1] === 'get-url' && args[2] === 'origin') {
        return Promise.resolve({ stdout: 'https://github.com/stablyai/orca.git\n' })
      }
      if (args[0] === 'remote' && args[1] === 'get-url' && args[2] === 'pr-pynickle-orca') {
        return Promise.resolve({ stdout: 'https://github.com/pynickle/orca.git\n' })
      }
      if (args[0] === 'remote' && args[1] === '-v') {
        return Promise.resolve({
          stdout: [
            'origin\thttps://github.com/stablyai/orca.git (fetch)',
            'origin\thttps://github.com/stablyai/orca.git (push)',
            'pr-pynickle-orca\thttps://github.com/pynickle/orca.git (fetch)',
            'pr-pynickle-orca\thttps://github.com/pynickle/orca.git (push)'
          ].join('\n')
        })
      }
      if (args[0] === 'remote') {
        return Promise.resolve({ stdout: 'origin\npr-pynickle-orca\n' })
      }
      if (
        args[0] === 'rev-parse' &&
        args.includes('refs/remotes/pr-pynickle-orca/imp/chinese-translation')
      ) {
        return Promise.resolve({ stdout: 'fork-head\n' })
      }
      if (args[0] === 'rev-list') {
        return Promise.resolve({ stdout: '2\t0\n' })
      }
      throw new Error(`unexpected git args: ${args.join(' ')}`)
    })

    const result = await getUpstreamStatus('/repo')

    expect(result).toEqual({
      hasUpstream: true,
      upstreamName: 'pr-pynickle-orca/imp/chinese-translation',
      ahead: 2,
      behind: 0
    })
  })

  it('uses a fork head branch even when its name matches the base branch', async () => {
    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      if (args[0] === 'symbolic-ref') {
        return Promise.resolve({ stdout: 'review/pr-1\n' })
      }
      if (args[0] === 'rev-parse' && args.includes('HEAD@{u}')) {
        return Promise.reject(new Error('fatal: no upstream configured'))
      }
      if (args[0] === 'config' && args.includes('branch.review/pr-1.remote')) {
        return Promise.resolve({ stdout: 'fork\n' })
      }
      if (args[0] === 'config' && args.includes('branch.review/pr-1.merge')) {
        return Promise.resolve({ stdout: 'refs/heads/main\n' })
      }
      if (args[0] === 'config' && args.includes('branch.review/pr-1.base')) {
        return Promise.resolve({ stdout: 'refs/remotes/origin/main\n' })
      }
      if (args[0] === 'rev-parse' && args.includes('refs/remotes/fork/main')) {
        return Promise.resolve({ stdout: 'fork-head\n' })
      }
      if (args[0] === 'rev-list') {
        return Promise.resolve({ stdout: '3\t0\n' })
      }
      throw new Error(`unexpected git args: ${args.join(' ')}`)
    })

    const result = await getUpstreamStatus('/repo')

    expect(result).toEqual({
      hasUpstream: true,
      upstreamName: 'fork/main',
      ahead: 3,
      behind: 0
    })
  })

  it('marks a URL-valued branch push target when no matching remote is configured', async () => {
    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      if (args[0] === 'symbolic-ref') {
        return Promise.resolve({ stdout: 'imp/chinese-translation\n' })
      }
      if (args[0] === 'rev-parse' && args.includes('HEAD@{u}')) {
        return Promise.reject(new Error('fatal: no upstream configured'))
      }
      if (args[0] === 'config' && args.includes('branch.imp/chinese-translation.pushRemote')) {
        return Promise.resolve({ stdout: 'https://github.com/pynickle/orca.git\n' })
      }
      if (args[0] === 'config' && args.includes('remote.pushDefault')) {
        return Promise.reject(new Error('missing pushDefault'))
      }
      if (args[0] === 'config' && args.includes('branch.imp/chinese-translation.remote')) {
        return Promise.resolve({ stdout: 'https://github.com/pynickle/orca.git\n' })
      }
      if (args[0] === 'config' && args.includes('branch.imp/chinese-translation.merge')) {
        return Promise.resolve({ stdout: 'refs/heads/imp/chinese-translation\n' })
      }
      if (args[0] === 'config' && args.includes('branch.imp/chinese-translation.base')) {
        return Promise.reject(new Error('missing branch base'))
      }
      if (args[0] === 'remote' && args[1] === 'get-url') {
        return Promise.resolve({ stdout: 'https://github.com/stablyai/orca.git\n' })
      }
      if (args[0] === 'remote') {
        return Promise.resolve({ stdout: 'origin\n' })
      }
      if (args[0] === 'rev-parse' && args.includes('refs/remotes/origin/imp/chinese-translation')) {
        return Promise.reject(new Error('missing origin tracking ref'))
      }
      throw new Error(`unexpected git args: ${args.join(' ')}`)
    })

    const result = await getUpstreamStatus('/repo')

    expect(result).toEqual({
      hasUpstream: false,
      ahead: 0,
      behind: 0,
      hasConfiguredPushTarget: true
    })
  })

  it('marks a fork head push target when the same-named base branch is on another remote', async () => {
    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      if (args[0] === 'symbolic-ref') {
        return Promise.resolve({ stdout: 'review/pr-1\n' })
      }
      if (args[0] === 'rev-parse' && args.includes('HEAD@{u}')) {
        return Promise.reject(new Error('fatal: no upstream configured'))
      }
      if (args[0] === 'config' && args.includes('branch.review/pr-1.pushRemote')) {
        return Promise.resolve({ stdout: 'fork\n' })
      }
      if (args[0] === 'config' && args.includes('remote.pushDefault')) {
        return Promise.reject(new Error('missing pushDefault'))
      }
      if (args[0] === 'config' && args.includes('branch.review/pr-1.remote')) {
        return Promise.resolve({ stdout: 'fork\n' })
      }
      if (args[0] === 'config' && args.includes('branch.review/pr-1.merge')) {
        return Promise.resolve({ stdout: 'refs/heads/main\n' })
      }
      if (args[0] === 'config' && args.includes('branch.review/pr-1.base')) {
        return Promise.resolve({ stdout: 'refs/remotes/origin/main\n' })
      }
      if (args[0] === 'rev-parse' && args.includes('refs/remotes/fork/main')) {
        return Promise.reject(new Error('missing fork tracking ref'))
      }
      if (args[0] === 'rev-parse' && args.includes('refs/remotes/origin/review/pr-1')) {
        return Promise.reject(new Error('missing origin review branch'))
      }
      throw new Error(`unexpected git args: ${args.join(' ')}`)
    })

    const result = await getUpstreamStatus('/repo')

    expect(result).toEqual({
      hasUpstream: false,
      ahead: 0,
      behind: 0,
      hasConfiguredPushTarget: true
    })
  })

  it('does not mark origin base-branch config as a push target', async () => {
    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      if (args[0] === 'symbolic-ref') {
        return Promise.resolve({ stdout: 'feature\n' })
      }
      if (args[0] === 'rev-parse' && args.includes('HEAD@{u}')) {
        return Promise.reject(new Error('fatal: no upstream configured'))
      }
      if (args[0] === 'config' && args.includes('branch.feature.pushRemote')) {
        return Promise.reject(new Error('missing pushRemote'))
      }
      if (args[0] === 'config' && args.includes('remote.pushDefault')) {
        return Promise.reject(new Error('missing pushDefault'))
      }
      if (args[0] === 'config' && args.includes('branch.feature.remote')) {
        return Promise.resolve({ stdout: 'origin\n' })
      }
      if (args[0] === 'config' && args.includes('branch.feature.merge')) {
        return Promise.resolve({ stdout: 'refs/heads/main\n' })
      }
      if (args[0] === 'config' && args.includes('branch.feature.base')) {
        return Promise.resolve({ stdout: 'refs/remotes/origin/main\n' })
      }
      if (args[0] === 'rev-parse' && args.includes('refs/remotes/origin/main')) {
        return Promise.reject(new Error('missing origin/main tracking ref'))
      }
      if (args[0] === 'rev-parse' && args.includes('refs/remotes/origin/feature')) {
        return Promise.reject(new Error('missing origin/feature tracking ref'))
      }
      throw new Error(`unexpected git args: ${args.join(' ')}`)
    })

    const result = await getUpstreamStatus('/repo')

    expect(result).toEqual({
      hasUpstream: false,
      ahead: 0,
      behind: 0
    })
  })

  it('does not mark remote.pushDefault plus origin base branch as a push target', async () => {
    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      if (args[0] === 'symbolic-ref') {
        return Promise.resolve({ stdout: 'feature/fix\n' })
      }
      if (args[0] === 'rev-parse' && args.includes('HEAD@{u}')) {
        return Promise.reject(new Error('fatal: no upstream configured'))
      }
      if (args[0] === 'config' && args.includes('branch.feature/fix.pushRemote')) {
        return Promise.reject(new Error('missing pushRemote'))
      }
      if (args[0] === 'config' && args.includes('remote.pushDefault')) {
        return Promise.resolve({ stdout: 'fork\n' })
      }
      if (args[0] === 'config' && args.includes('branch.feature/fix.remote')) {
        return Promise.resolve({ stdout: 'origin\n' })
      }
      if (args[0] === 'config' && args.includes('branch.feature/fix.merge')) {
        return Promise.resolve({ stdout: 'refs/heads/main\n' })
      }
      if (args[0] === 'config' && args.includes('branch.feature/fix.base')) {
        return Promise.resolve({ stdout: 'refs/remotes/origin/main\n' })
      }
      if (args[0] === 'rev-parse' && args.includes('refs/remotes/origin/feature/fix')) {
        return Promise.reject(new Error('missing origin feature branch'))
      }
      throw new Error(`unexpected git args: ${args.join(' ')}`)
    })

    const result = await getUpstreamStatus('/repo')

    expect(result).toEqual({
      hasUpstream: false,
      ahead: 0,
      behind: 0
    })
  })

  it('keeps a configured upstream whose remote name contains a slash', async () => {
    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      if (args[0] === 'symbolic-ref') {
        return Promise.resolve({ stdout: 'feature\n' })
      }
      if (args[0] === 'rev-parse' && args.includes('HEAD@{u}')) {
        return Promise.resolve({ stdout: 'origin/team/feature\n' })
      }
      if (args[0] === 'remote') {
        return Promise.resolve({ stdout: 'origin\norigin/team\n' })
      }
      if (args[0] === 'rev-parse' && args.includes('refs/remotes/origin/feature')) {
        return Promise.resolve({ stdout: 'origin-feature-oid\n' })
      }
      if (args[0] === 'rev-list' && args.includes('HEAD...origin/team/feature')) {
        return Promise.resolve({ stdout: '2\t0\n' })
      }
      if (args[0] === 'rev-list' && args.includes('HEAD...origin/feature')) {
        return Promise.resolve({ stdout: '9\t9\n' })
      }
      throw new Error(`unexpected git args: ${args.join(' ')}`)
    })

    const result = await getUpstreamStatus('/repo')

    expect(result).toEqual({
      hasUpstream: true,
      upstreamName: 'origin/team/feature',
      ahead: 2,
      behind: 0
    })
  })

  it('uses an explicit publish target instead of the configured upstream', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'abc123\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: '1\t2\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: '+ def456 remote work\n', stderr: '' })

    const result = await getUpstreamStatus('/repo', {
      remoteName: 'fork',
      branchName: 'feature/fix'
    })

    expect(result).toEqual({
      hasUpstream: true,
      upstreamName: 'fork/feature/fix',
      ahead: 1,
      behind: 2,
      behindCommitsArePatchEquivalent: false
    })
    expect(gitExecFileAsyncMock.mock.calls).toEqual([
      [['check-ref-format', '--branch', 'feature/fix'], { cwd: '/repo' }],
      [['rev-parse', '--verify', '--quiet', 'refs/remotes/fork/feature/fix'], { cwd: '/repo' }],
      [
        ['rev-list', '--left-right', '--count', 'HEAD...refs/remotes/fork/feature/fix'],
        { cwd: '/repo' }
      ],
      [
        [
          'log',
          '--oneline',
          '--cherry-mark',
          '--right-only',
          'HEAD...refs/remotes/fork/feature/fix',
          '--'
        ],
        { cwd: '/repo' }
      ]
    ])
  })

  it('routes explicit publish-target probes through the selected WSL distro', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'abc123\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: '0\t0\n', stderr: '' })

    await expect(
      getUpstreamStatus(
        '/repo',
        {
          remoteName: 'fork',
          branchName: 'feature/fix'
        },
        { wslDistro: 'Ubuntu' }
      )
    ).resolves.toEqual({
      hasUpstream: true,
      upstreamName: 'fork/feature/fix',
      ahead: 0,
      behind: 0
    })
    expect(gitExecFileAsyncMock.mock.calls).toEqual([
      [['check-ref-format', '--branch', 'feature/fix'], { cwd: '/repo', wslDistro: 'Ubuntu' }],
      [
        ['rev-parse', '--verify', '--quiet', 'refs/remotes/fork/feature/fix'],
        { cwd: '/repo', wslDistro: 'Ubuntu' }
      ],
      [
        ['rev-list', '--left-right', '--count', 'HEAD...refs/remotes/fork/feature/fix'],
        { cwd: '/repo', wslDistro: 'Ubuntu' }
      ]
    ])
  })

  it('reports no upstream when an explicit publish target has not been fetched yet', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockRejectedValueOnce(Object.assign(new Error('git exited with 1.'), { stderr: '' }))

    await expect(
      getUpstreamStatus('/repo', {
        remoteName: 'fork',
        branchName: 'feature/fix'
      })
    ).resolves.toEqual({
      hasUpstream: false,
      upstreamName: 'fork/feature/fix',
      ahead: 0,
      behind: 0,
      hasConfiguredPushTarget: true
    })
  })

  it('does not hide git failures while checking an explicit publish target', async () => {
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '', stderr: '' }).mockRejectedValueOnce(
      Object.assign(new Error('fatal: not a git repository'), {
        stderr: 'fatal: not a git repository'
      })
    )

    await expect(
      getUpstreamStatus('/repo', {
        remoteName: 'fork',
        branchName: 'feature/fix'
      })
    ).rejects.toThrow('fatal: not a git repository')
  })
})
