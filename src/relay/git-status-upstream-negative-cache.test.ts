import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearNoEffectiveUpstreamStatusCache,
  clearNoEffectiveUpstreamStatusCacheEntry,
  getNoEffectiveUpstreamStatusCacheCountForTests,
  getNoEffectiveUpstreamStatusGenerationCountForTests,
  readOrProbeNoEffectiveUpstreamStatus
} from './git-status-upstream-negative-cache'

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
})
