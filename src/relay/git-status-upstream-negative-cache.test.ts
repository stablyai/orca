import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearNoEffectiveUpstreamStatusCache,
  clearNoEffectiveUpstreamStatusCacheEntry,
  getNoEffectiveUpstreamStatusCacheCountForTests,
  getNoEffectiveUpstreamStatusGenerationCountForTests,
  MAX_NO_EFFECTIVE_UPSTREAM_CACHE_KEY_BYTES,
  readOrProbeNoEffectiveUpstreamStatus
} from './git-status-upstream-negative-cache'

function isConfigListSnapshotCommand(args: string[]): boolean {
  return args[0] === 'config' && args[1] === '--list' && args[2] === '-z'
}

function emptyGitConfigSnapshot(): { stdout: string } {
  return { stdout: 'core.repositoryformatversion\n0\0' }
}

describe('relay upstream negative cache', () => {
  beforeEach(() => {
    clearNoEffectiveUpstreamStatusCache()
  })

  afterEach(() => {
    clearNoEffectiveUpstreamStatusCache()
  })

  it('bypasses cached no-effective-upstream status when requested', async () => {
    let originBranchExists = false
    const runGit = vi.fn(async (args: string[]): Promise<{ stdout: string }> => {
      if (args[0] === 'symbolic-ref') {
        return { stdout: 'feature\n' }
      }
      if (args[0] === 'rev-parse' && args.includes('HEAD@{u}')) {
        throw new Error('fatal: no upstream configured for branch feature')
      }
      if (isConfigListSnapshotCommand(args)) {
        return emptyGitConfigSnapshot()
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
      throw new Error(`No upstream fixture for git ${args.join(' ')}`)
    })
    const identity = { worktreePath: '/repo', branchName: 'feature' }

    const first = await readOrProbeNoEffectiveUpstreamStatus(identity, runGit)
    originBranchExists = true
    const automatic = await readOrProbeNoEffectiveUpstreamStatus(identity, runGit)
    const strict = await readOrProbeNoEffectiveUpstreamStatus(identity, runGit, {
      bypassCache: true
    })

    expect(first).toEqual({ hasUpstream: false, ahead: 0, behind: 0 })
    expect(automatic).toEqual(first)
    expect(strict).toEqual({
      hasUpstream: true,
      upstreamName: 'origin/feature',
      ahead: 0,
      behind: 1
    })
  })

  it('keeps an older automatic negative probe from overwriting a strict positive result', async () => {
    let originBranchExists = false
    let deferredOriginReject: ((error: Error) => void) | null = null
    const runGit = vi.fn(async (args: string[]) => {
      if (args[0] === 'symbolic-ref') {
        return { stdout: 'feature\n' }
      }
      if (args[0] === 'rev-parse' && args.includes('HEAD@{u}')) {
        throw new Error('fatal: no upstream configured for branch feature')
      }
      if (isConfigListSnapshotCommand(args)) {
        return emptyGitConfigSnapshot()
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
      throw new Error(`No upstream fixture for git ${args.join(' ')}`)
    })
    const identity = { worktreePath: '/repo', branchName: 'feature' }

    const automatic = readOrProbeNoEffectiveUpstreamStatus(identity, runGit)
    await vi.waitFor(() => expect(deferredOriginReject).toBeTruthy())

    originBranchExists = true
    const strict = await readOrProbeNoEffectiveUpstreamStatus(identity, runGit, {
      bypassCache: true
    })
    if (!deferredOriginReject) {
      throw new Error('expected deferred origin reject')
    }
    ;(deferredOriginReject as (error: Error) => void)(new Error('missing remote branch'))
    const staleAutomatic = await automatic
    const nextAutomatic = await readOrProbeNoEffectiveUpstreamStatus(identity, runGit)

    expect(strict).toEqual({
      hasUpstream: true,
      upstreamName: 'origin/feature',
      ahead: 0,
      behind: 1
    })
    expect(staleAutomatic).toEqual({ hasUpstream: false, ahead: 0, behind: 0 })
    expect(nextAutomatic).toEqual(strict)
  })

  it('does not trim generation for an unresolved automatic probe', async () => {
    let originBranchExists = false
    let deferredOriginReject: ((error: Error) => void) | null = null
    const runGit = vi.fn(async (args: string[]): Promise<{ stdout: string }> => {
      if (args[0] === 'symbolic-ref') {
        return { stdout: 'feature\n' }
      }
      if (args[0] === 'rev-parse' && args.includes('HEAD@{u}')) {
        throw new Error('fatal: no upstream configured for branch feature')
      }
      if (isConfigListSnapshotCommand(args)) {
        return emptyGitConfigSnapshot()
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
      throw new Error(`No upstream fixture for git ${args.join(' ')}`)
    })
    const identity = { worktreePath: '/repo', branchName: 'feature' }

    const automatic = readOrProbeNoEffectiveUpstreamStatus(identity, runGit)
    await vi.waitFor(() => expect(deferredOriginReject).toBeTruthy())

    originBranchExists = true
    const strict = await readOrProbeNoEffectiveUpstreamStatus(identity, runGit, {
      bypassCache: true
    })
    for (let index = 0; index < 512; index += 1) {
      const branchName = `other-${index}`
      await readOrProbeNoEffectiveUpstreamStatus(
        { worktreePath: '/repo', branchName },
        async (args) => {
          if (args[0] === 'symbolic-ref') {
            return { stdout: `${branchName}\n` }
          }
          if (args[0] === 'rev-parse' && args.includes('HEAD@{u}')) {
            throw new Error(`fatal: no upstream configured for branch ${branchName}`)
          }
          if (isConfigListSnapshotCommand(args)) {
            return emptyGitConfigSnapshot()
          }
          if (args[0] === 'rev-parse' && args.includes(`refs/remotes/origin/${branchName}`)) {
            return { stdout: 'abc123\n' }
          }
          if (args[0] === 'rev-list' && args.includes(`HEAD...origin/${branchName}`)) {
            return { stdout: '0\t1\n' }
          }
          throw new Error(`No upstream fixture for git ${args.join(' ')}`)
        },
        { bypassCache: true }
      )
    }
    if (!deferredOriginReject) {
      throw new Error('expected deferred origin reject')
    }
    ;(deferredOriginReject as (error: Error) => void)(new Error('missing remote branch'))
    await automatic
    const nextAutomatic = await readOrProbeNoEffectiveUpstreamStatus(identity, runGit)

    expect(strict).toEqual({
      hasUpstream: true,
      upstreamName: 'origin/feature',
      ahead: 0,
      behind: 1
    })
    expect(nextAutomatic).toEqual(strict)
    expect(getNoEffectiveUpstreamStatusGenerationCountForTests()).toBeLessThanOrEqual(512)
  })

  it('does not trim generation for a cleared automatic probe before it settles', async () => {
    let originBranchExists = false
    let deferredOriginReject: ((error: Error) => void) | null = null
    const runGit = vi.fn(async (args: string[]): Promise<{ stdout: string }> => {
      if (args[0] === 'symbolic-ref') {
        return { stdout: 'feature\n' }
      }
      if (args[0] === 'rev-parse' && args.includes('HEAD@{u}')) {
        throw new Error('fatal: no upstream configured for branch feature')
      }
      if (isConfigListSnapshotCommand(args)) {
        return emptyGitConfigSnapshot()
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
      throw new Error(`No upstream fixture for git ${args.join(' ')}`)
    })
    const identity = { worktreePath: '/repo', branchName: 'feature' }

    const automatic = readOrProbeNoEffectiveUpstreamStatus(identity, runGit)
    await vi.waitFor(() => expect(deferredOriginReject).toBeTruthy())

    originBranchExists = true
    clearNoEffectiveUpstreamStatusCacheEntry(identity)
    for (let index = 0; index < 512; index += 1) {
      const branchName = `other-${index}`
      await readOrProbeNoEffectiveUpstreamStatus(
        { worktreePath: '/repo', branchName },
        async (args) => {
          if (args[0] === 'symbolic-ref') {
            return { stdout: `${branchName}\n` }
          }
          if (args[0] === 'rev-parse' && args.includes('HEAD@{u}')) {
            throw new Error(`fatal: no upstream configured for branch ${branchName}`)
          }
          if (isConfigListSnapshotCommand(args)) {
            return emptyGitConfigSnapshot()
          }
          if (args[0] === 'rev-parse' && args.includes(`refs/remotes/origin/${branchName}`)) {
            return { stdout: 'abc123\n' }
          }
          if (args[0] === 'rev-list' && args.includes(`HEAD...origin/${branchName}`)) {
            return { stdout: '0\t1\n' }
          }
          throw new Error(`No upstream fixture for git ${args.join(' ')}`)
        },
        { bypassCache: true }
      )
    }
    if (!deferredOriginReject) {
      throw new Error('expected deferred origin reject')
    }
    ;(deferredOriginReject as (error: Error) => void)(new Error('missing remote branch'))
    await automatic
    const nextAutomatic = await readOrProbeNoEffectiveUpstreamStatus(identity, runGit)

    expect(nextAutomatic).toEqual({
      hasUpstream: true,
      upstreamName: 'origin/feature',
      ahead: 0,
      behind: 1
    })
    expect(getNoEffectiveUpstreamStatusGenerationCountForTests()).toBeLessThanOrEqual(512)
  })

  it('bounds no-effective-upstream entries', async () => {
    for (let index = 0; index < 513; index += 1) {
      const branchName = `feature-${index}`
      await readOrProbeNoEffectiveUpstreamStatus(
        { worktreePath: '/repo', branchName },
        async (args) => {
          if (args[0] === 'symbolic-ref') {
            return { stdout: `${branchName}\n` }
          }
          if (args[0] === 'rev-parse' && args.includes('HEAD@{u}')) {
            throw new Error(`fatal: no upstream configured for branch ${branchName}`)
          }
          if (isConfigListSnapshotCommand(args)) {
            return emptyGitConfigSnapshot()
          }
          if (args[0] === 'rev-parse' && args.includes(`refs/remotes/origin/${branchName}`)) {
            throw new Error('missing remote branch')
          }
          throw new Error(`No upstream fixture for git ${args.join(' ')}`)
        }
      )
    }

    expect(getNoEffectiveUpstreamStatusCacheCountForTests()).toBe(512)
    expect(getNoEffectiveUpstreamStatusGenerationCountForTests()).toBeLessThanOrEqual(512)
  })

  it('bounds write-generation entries from positive strict probes', async () => {
    for (let index = 0; index < 513; index += 1) {
      const branchName = `feature-${index}`
      await readOrProbeNoEffectiveUpstreamStatus(
        { worktreePath: '/repo', branchName },
        async (args) => {
          if (args[0] === 'symbolic-ref') {
            return { stdout: `${branchName}\n` }
          }
          if (args[0] === 'rev-parse' && args.includes('HEAD@{u}')) {
            throw new Error(`fatal: no upstream configured for branch ${branchName}`)
          }
          if (isConfigListSnapshotCommand(args)) {
            return emptyGitConfigSnapshot()
          }
          if (args[0] === 'rev-parse' && args.includes(`refs/remotes/origin/${branchName}`)) {
            return { stdout: 'abc123\n' }
          }
          if (args[0] === 'rev-list' && args.includes(`HEAD...origin/${branchName}`)) {
            return { stdout: '0\t1\n' }
          }
          throw new Error(`No upstream fixture for git ${args.join(' ')}`)
        },
        { bypassCache: true }
      )
    }

    expect(getNoEffectiveUpstreamStatusCacheCountForTests()).toBe(0)
    expect(getNoEffectiveUpstreamStatusGenerationCountForTests()).toBe(512)
  })

  it('retains the exact key-byte boundary but not oversized identities', async () => {
    const worktreePath = '/r'
    const keyOverheadBytes = Buffer.byteLength(`${worktreePath}\0\0`, 'utf8')
    const exactBranch = 'x'.repeat(MAX_NO_EFFECTIVE_UPSTREAM_CACHE_KEY_BYTES - keyOverheadBytes)
    const oversizedBranch = `${exactBranch}x`
    const createRunner = (branchName: string) =>
      vi.fn(async (args: string[]): Promise<{ stdout: string }> => {
        if (args[0] === 'symbolic-ref') {
          return { stdout: `${branchName}\n` }
        }
        if (args[0] === 'rev-parse' && args.includes('HEAD@{u}')) {
          throw new Error(`fatal: no upstream configured for branch ${branchName}`)
        }
        if (isConfigListSnapshotCommand(args)) {
          return emptyGitConfigSnapshot()
        }
        if (args[0] === 'rev-parse') {
          throw new Error('missing remote branch')
        }
        throw new Error(`No upstream fixture for git ${args.join(' ')}`)
      })
    const exactRunner = createRunner(exactBranch)
    const oversizedRunner = createRunner(oversizedBranch)

    await readOrProbeNoEffectiveUpstreamStatus(
      { worktreePath, branchName: exactBranch },
      exactRunner
    )
    await readOrProbeNoEffectiveUpstreamStatus(
      { worktreePath, branchName: exactBranch },
      exactRunner
    )
    await readOrProbeNoEffectiveUpstreamStatus(
      { worktreePath, branchName: oversizedBranch },
      oversizedRunner
    )
    await readOrProbeNoEffectiveUpstreamStatus(
      { worktreePath, branchName: oversizedBranch },
      oversizedRunner
    )
    clearNoEffectiveUpstreamStatusCacheEntry({
      worktreePath,
      branchName: oversizedBranch
    })

    expect(exactRunner.mock.calls.filter(([args]) => args[0] === 'symbolic-ref')).toHaveLength(1)
    expect(oversizedRunner.mock.calls.filter(([args]) => args[0] === 'symbolic-ref')).toHaveLength(
      2
    )
    expect(getNoEffectiveUpstreamStatusCacheCountForTests()).toBe(1)
    expect(getNoEffectiveUpstreamStatusGenerationCountForTests()).toBe(0)
  })

  it('coalesces no-upstream config reads into one snapshot subprocess', async () => {
    const runGit = vi.fn(async (args: string[]): Promise<{ stdout: string }> => {
      if (args[0] === 'symbolic-ref') {
        return { stdout: 'feature\n' }
      }
      if (args[0] === 'rev-parse' && args.includes('HEAD@{u}')) {
        throw new Error('fatal: no upstream configured for branch feature')
      }
      if (isConfigListSnapshotCommand(args)) {
        return emptyGitConfigSnapshot()
      }
      if (args[0] === 'rev-parse' && args.includes('refs/remotes/origin/feature')) {
        throw new Error('missing remote branch')
      }
      throw new Error(`No upstream fixture for git ${args.join(' ')}`)
    })

    const status = await readOrProbeNoEffectiveUpstreamStatus(
      { worktreePath: '/repo', branchName: 'feature' },
      runGit
    )
    const configListCalls = runGit.mock.calls.filter((call) =>
      isConfigListSnapshotCommand(call[0] as string[])
    )
    const configGetCalls = runGit.mock.calls.filter((call) => {
      const args = call[0] as string[]
      return args[0] === 'config' && args[1] === '--get'
    })

    expect(configListCalls).toHaveLength(1)
    expect(configGetCalls).toHaveLength(0)
    expect(status.hasUpstream).toBe(false)
  })
})
