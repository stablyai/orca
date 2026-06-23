import { mkdtempSync } from 'fs'
import * as fs from 'fs/promises'
import { tmpdir } from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitExec } from './git-handler-ops'
import { getStatusOp } from './git-handler-status-ops'
import { clearNoEffectiveUpstreamStatusCache } from './git-status-upstream-negative-cache'

const LARGE_STATUS_ENTRY_COUNT = 150_000

function buildLargeStatusOutput(count: number): string {
  const lines: string[] = []
  for (let index = 0; index < count; index += 1) {
    lines.push(`1 A. N... 100644 100644 100644 000000 111111 generated-${index}.txt`)
  }
  return lines.join('\n')
}

function buildBranchStatusOutput(head: string, branch: string): string {
  return [`# branch.oid ${head}`, `# branch.head ${branch}`].join('\n')
}

describe('getStatusOp', () => {
  let tmpDir: string

  beforeEach(() => {
    clearNoEffectiveUpstreamStatusCache()
    tmpDir = mkdtempSync(path.join(tmpdir(), 'relay-git-status-'))
  })

  afterEach(async () => {
    clearNoEffectiveUpstreamStatusCache()
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('truncates huge status lists at the limit and flags didHitLimit', async () => {
    const statusOutput = buildLargeStatusOutput(LARGE_STATUS_ENTRY_COUNT)
    const git = vi.fn<GitExec>(async (args) => {
      if (args.includes('status')) {
        return { stdout: statusOutput, stderr: '' }
      }
      if (args.includes('diff')) {
        return { stdout: '', stderr: '' }
      }
      throw new Error(`Unexpected git command: ${args.join(' ')}`)
    })

    const result = await getStatusOp(git, { worktreePath: tmpDir, limit: 10_000 })

    expect(result.didHitLimit).toBe(true)
    expect(result.statusLength).toBe(LARGE_STATUS_ENTRY_COUNT)
    expect(result.entries).toHaveLength(10_000)
    expect(result.entries[0]).toEqual({
      path: 'generated-0.txt',
      status: 'added',
      area: 'staged'
    })
    // numstat (diff) must be skipped when the limit was hit.
    expect(git.mock.calls.some(([args]) => args.includes('diff'))).toBe(false)
  })

  it('returns the full list and no limit flag when under the limit', async () => {
    const statusOutput = buildLargeStatusOutput(5)
    const git = vi.fn<GitExec>(async (args) => {
      if (args.includes('status')) {
        return { stdout: statusOutput, stderr: '' }
      }
      if (args.includes('diff')) {
        return { stdout: '', stderr: '' }
      }
      throw new Error(`Unexpected git command: ${args.join(' ')}`)
    })

    const result = await getStatusOp(git, { worktreePath: tmpDir, limit: 10_000 })

    expect(result.didHitLimit).toBeUndefined()
    expect(result.entries).toHaveLength(5)
  })

  it('caches no-effective-upstream probes across status polls for the same head', async () => {
    const git = vi.fn<GitExec>(async (args) => {
      if (args.includes('status')) {
        return { stdout: buildBranchStatusOutput('abc123', 'feature'), stderr: '' }
      }
      if (args[0] === 'symbolic-ref') {
        return { stdout: 'feature\n', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args.includes('HEAD@{u}')) {
        throw new Error('fatal: no upstream configured for branch feature')
      }
      throw new Error(`No upstream fixture for git ${args.join(' ')}`)
    })

    const first = await getStatusOp(git, { worktreePath: tmpDir })
    const firstCallCount = git.mock.calls.length
    const second = await getStatusOp(git, { worktreePath: tmpDir })

    expect(first.upstreamStatus).toEqual({ hasUpstream: false, ahead: 0, behind: 0 })
    expect(second.upstreamStatus).toEqual(first.upstreamStatus)
    expect(git.mock.calls).toHaveLength(firstCallCount + 1)
    expect(
      git.mock.calls.filter(([args]) => args[0] === 'rev-parse' && args.includes('HEAD@{u}'))
    ).toHaveLength(1)
    expect(
      git.mock.calls.filter(
        ([args]) => args[0] === 'rev-parse' && args.includes('refs/remotes/origin/feature')
      )
    ).toHaveLength(1)
  })

  it('coalesces concurrent no-effective-upstream probes', async () => {
    const git = vi.fn<GitExec>(async (args) => {
      if (args.includes('status')) {
        return { stdout: buildBranchStatusOutput('abc123', 'feature'), stderr: '' }
      }
      if (args[0] === 'symbolic-ref') {
        return { stdout: 'feature\n', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args.includes('HEAD@{u}')) {
        await Promise.resolve()
        throw new Error('fatal: no upstream configured for branch feature')
      }
      if (args[0] === 'rev-parse' && args.includes('refs/remotes/origin/feature')) {
        await Promise.resolve()
        throw new Error('missing remote branch')
      }
      throw new Error(`No upstream fixture for git ${args.join(' ')}`)
    })

    await Promise.all([
      getStatusOp(git, { worktreePath: tmpDir }),
      getStatusOp(git, { worktreePath: tmpDir }),
      getStatusOp(git, { worktreePath: tmpDir })
    ])

    expect(
      git.mock.calls.filter(([args]) => args[0] === 'rev-parse' && args.includes('HEAD@{u}'))
    ).toHaveLength(1)
    expect(
      git.mock.calls.filter(
        ([args]) => args[0] === 'rev-parse' && args.includes('refs/remotes/origin/feature')
      )
    ).toHaveLength(1)
  })

  it('invalidates cached no-effective-upstream probes when the branch changes', async () => {
    let branch = 'feature'
    const git = vi.fn<GitExec>(async (args) => {
      if (args.includes('status')) {
        return { stdout: buildBranchStatusOutput('abc123', branch), stderr: '' }
      }
      if (args[0] === 'symbolic-ref') {
        return { stdout: `${branch}\n`, stderr: '' }
      }
      if (args[0] === 'rev-parse' && args.includes('HEAD@{u}')) {
        throw new Error(`fatal: no upstream configured for branch ${branch}`)
      }
      if (args[0] === 'rev-parse' && args.some((arg) => arg.startsWith('refs/remotes/origin/'))) {
        throw new Error('missing remote branch')
      }
      throw new Error(`No upstream fixture for git ${args.join(' ')}`)
    })

    await getStatusOp(git, { worktreePath: tmpDir })
    branch = 'other-feature'
    await getStatusOp(git, { worktreePath: tmpDir })

    expect(
      git.mock.calls
        .filter(
          ([args]) =>
            args[0] === 'rev-parse' && args.some((arg) => arg.startsWith('refs/remotes/origin/'))
        )
        .map(([args]) => args.at(-1))
    ).toEqual(['refs/remotes/origin/feature', 'refs/remotes/origin/other-feature'])
  })

  it('does not cache a configured push target signal', async () => {
    const git = vi.fn<GitExec>(async (args) => {
      if (args.includes('status')) {
        return { stdout: buildBranchStatusOutput('abc123', 'feature/fix'), stderr: '' }
      }
      if (args[0] === 'symbolic-ref') {
        return { stdout: 'feature/fix\n', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args.includes('HEAD@{u}')) {
        throw new Error('fatal: no upstream configured for branch feature/fix')
      }
      if (args[0] === 'config' && args.includes('branch.feature/fix.pushRemote')) {
        return { stdout: 'fork\n', stderr: '' }
      }
      if (args[0] === 'config' && args.includes('remote.pushDefault')) {
        throw new Error('missing push default')
      }
      if (args[0] === 'config' && args.includes('branch.feature/fix.remote')) {
        return { stdout: 'fork\n', stderr: '' }
      }
      if (args[0] === 'config' && args.includes('branch.feature/fix.merge')) {
        return { stdout: 'refs/heads/feature/fix\n', stderr: '' }
      }
      if (args[0] === 'config' && args.includes('branch.feature/fix.base')) {
        throw new Error('missing branch base')
      }
      if (args[0] === 'rev-parse' && args.some((arg) => arg.startsWith('refs/remotes/'))) {
        throw new Error('missing remote branch')
      }
      throw new Error(`No upstream fixture for git ${args.join(' ')}`)
    })

    await getStatusOp(git, { worktreePath: tmpDir })
    await getStatusOp(git, { worktreePath: tmpDir })

    expect(
      git.mock.calls.filter(([args]) => args[0] === 'rev-parse' && args.includes('HEAD@{u}'))
    ).toHaveLength(2)
  })
})
