import { mkdtempSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitExec } from './git-handler-ops'
import type { RelayGitStreamExec } from './git-stdout-stream'
import { getStatusOp } from './git-handler-status-ops'
import { clearNoEffectiveUpstreamStatusCache } from './git-status-upstream-negative-cache'
import { clearGitStatusLineStatsCache } from '../shared/git-status-line-stats-cache'
import { DEFAULT_GIT_STATUS_LIMIT } from '../shared/git-status-limit'

const LARGE_STATUS_ENTRY_COUNT = 150_000

function streamGitFromCapture(git: GitExec): RelayGitStreamExec {
  return async (args, cwd, options) => {
    const { stdout } = await git(args, cwd, {
      disableOptionalLocks: options.disableOptionalLocks,
      signal: options.signal
    })
    return { stoppedEarly: options.onStdout(stdout) === true }
  }
}

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
    clearGitStatusLineStatsCache()
    tmpDir = mkdtempSync(path.join(tmpdir(), 'relay-git-status-'))
  })

  afterEach(async () => {
    vi.useRealTimers()
    clearNoEffectiveUpstreamStatusCache()
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('truncates huge status lists at the limit and flags didHitLimit', async () => {
    let emittedEntries = 0
    const git = vi.fn<GitExec>(async (args) => {
      throw new Error(`Unexpected git command: ${args.join(' ')}`)
    })
    const streamGit = vi.fn<RelayGitStreamExec>(async (_args, _cwd, options) => {
      for (let index = 0; index < LARGE_STATUS_ENTRY_COUNT; index += 1) {
        emittedEntries += 1
        if (
          options.onStdout(
            `1 A. N... 100644 100644 100644 000000 111111 generated-${index}.txt\n`
          ) === true
        ) {
          return { stoppedEarly: true }
        }
      }
      return { stoppedEarly: false }
    })

    const result = await getStatusOp(git, streamGit, { worktreePath: tmpDir })

    expect(result.didHitLimit).toBe(true)
    expect(result.statusLength).toBe(DEFAULT_GIT_STATUS_LIMIT + 1)
    expect(result.entries).toHaveLength(DEFAULT_GIT_STATUS_LIMIT)
    expect(emittedEntries).toBe(DEFAULT_GIT_STATUS_LIMIT + 1)
    expect(streamGit).toHaveBeenCalledWith(
      expect.arrayContaining(['status', '--porcelain=v2']),
      tmpDir,
      expect.objectContaining({ disableOptionalLocks: true })
    )
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

    const result = await getStatusOp(git, streamGitFromCapture(git), {
      worktreePath: tmpDir,
      limit: 10_000
    })

    expect(result.didHitLimit).toBeUndefined()
    expect(result.entries).toHaveLength(5)
  })

  it('returns exactly the cap without a false limit signal', async () => {
    const git = vi.fn<GitExec>(async (args) => {
      if (args.includes('status')) {
        return { stdout: buildLargeStatusOutput(3), stderr: '' }
      }
      if (args.includes('diff')) {
        return { stdout: '', stderr: '' }
      }
      throw new Error(`Unexpected git command: ${args.join(' ')}`)
    })

    const result = await getStatusOp(git, streamGitFromCapture(git), {
      worktreePath: tmpDir,
      limit: 3
    })

    expect(result.entries).toHaveLength(3)
    expect(result.didHitLimit).toBeUndefined()
    expect(result.statusLength).toBeUndefined()
  })

  it('caps unmerged conflicts and keeps the visible conflict rows', async () => {
    const lines = [
      'u UU S... 160000 160000 160000 160000 aa bb cc vendor/submodule',
      ...Array.from(
        { length: 3 },
        (_, i) => `u UU N... 100644 100644 100644 100644 aa bb cc conflict-${i}.ts`
      )
    ].join('\n')
    const git = vi.fn<GitExec>(async (args) => {
      if (args.includes('status')) {
        return { stdout: `${lines}\n`, stderr: '' }
      }
      throw new Error(`Unexpected git command: ${args.join(' ')}`)
    })

    const result = await getStatusOp(git, streamGitFromCapture(git), {
      worktreePath: tmpDir,
      limit: 2
    })

    expect(result.didHitLimit).toBe(true)
    expect(result.statusLength).toBe(3)
    expect(result.entries).toHaveLength(2)
    expect(result.entries.map((entry) => entry.path)).toEqual(['conflict-0.ts', 'conflict-1.ts'])
    expect(result.entries.every((entry) => entry.conflictStatus === 'unresolved')).toBe(true)
    expect(git).toHaveBeenCalledTimes(1)
  })

  it('keeps an early conflict ahead of later ordinary rows at the cap', async () => {
    const lines = [
      '? before.ts',
      'u UU N... 100644 100644 100644 100644 aa bb cc conflict.ts',
      '? after.ts'
    ].join('\n')
    const git = vi.fn<GitExec>(async (args) => {
      if (args.includes('status')) {
        return { stdout: `${lines}\n`, stderr: '' }
      }
      throw new Error(`Unexpected git command: ${args.join(' ')}`)
    })

    const result = await getStatusOp(git, streamGitFromCapture(git), {
      worktreePath: tmpDir,
      limit: 2
    })

    expect(result.didHitLimit).toBe(true)
    expect(result.entries.map((entry) => entry.path)).toEqual(['before.ts', 'conflict.ts'])
    expect(result.entries[1]).toMatchObject({
      conflictKind: 'both_modified',
      conflictStatus: 'unresolved'
    })
  })

  it('reuses unchanged line stats only for hinted safety reads', async () => {
    const statusOutput = `${buildBranchStatusOutput('head-1', '(detached)')}\n1 .M N... 100644 100644 100644 aaaa aaaa src/a.ts`
    const git = vi.fn<GitExec>(async (args) => {
      if (args.includes('status')) {
        return { stdout: statusOutput, stderr: '' }
      }
      if (args.includes('diff')) {
        return { stdout: '3\t2\tsrc/a.ts\n', stderr: '' }
      }
      throw new Error(`Unexpected git command: ${args.join(' ')}`)
    })

    await getStatusOp(git, streamGitFromCapture(git), { worktreePath: tmpDir })
    const reused = await getStatusOp(git, streamGitFromCapture(git), {
      worktreePath: tmpDir,
      reuseLineStats: true
    })
    await getStatusOp(git, streamGitFromCapture(git), { worktreePath: tmpDir })

    expect(reused.entries).toContainEqual(
      expect.objectContaining({ path: 'src/a.ts', added: 3, removed: 2 })
    )
    expect(git.mock.calls.filter(([args]) => args.includes('diff'))).toHaveLength(2)
  })

  it('forwards the request abort signal to status and numstat subprocesses', async () => {
    const controller = new AbortController()
    const git = vi.fn<GitExec>(async (args) => {
      if (args.includes('status')) {
        return {
          stdout: '1 .M N... 100644 100644 100644 aaaa aaaa src/a.ts',
          stderr: ''
        }
      }
      if (args.includes('diff')) {
        return { stdout: '1\t0\tsrc/a.ts\n', stderr: '' }
      }
      throw new Error(`Unexpected git command: ${args.join(' ')}`)
    })

    await getStatusOp(
      git,
      streamGitFromCapture(git),
      { worktreePath: tmpDir },
      { signal: controller.signal }
    )

    expect(git.mock.calls).not.toHaveLength(0)
    for (const [, , options] of git.mock.calls) {
      expect(options?.signal).toBe(controller.signal)
    }
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

    const first = await getStatusOp(git, streamGitFromCapture(git), { worktreePath: tmpDir })
    const firstCallCount = git.mock.calls.length
    const second = await getStatusOp(git, streamGitFromCapture(git), { worktreePath: tmpDir })

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

  it('keeps no-effective-upstream probes cached beyond thirty seconds', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
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
      if (args[0] === 'rev-parse' && args.includes('refs/remotes/origin/feature')) {
        throw new Error('missing remote branch')
      }
      throw new Error(`No upstream fixture for git ${args.join(' ')}`)
    })

    await getStatusOp(git, streamGitFromCapture(git), { worktreePath: tmpDir })
    vi.setSystemTime(31_000)
    await getStatusOp(git, streamGitFromCapture(git), { worktreePath: tmpDir })

    expect(
      git.mock.calls.filter(([args]) => args[0] === 'rev-parse' && args.includes('HEAD@{u}'))
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
      getStatusOp(git, streamGitFromCapture(git), { worktreePath: tmpDir }),
      getStatusOp(git, streamGitFromCapture(git), { worktreePath: tmpDir }),
      getStatusOp(git, streamGitFromCapture(git), { worktreePath: tmpDir })
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

    await getStatusOp(git, streamGitFromCapture(git), { worktreePath: tmpDir })
    branch = 'other-feature'
    await getStatusOp(git, streamGitFromCapture(git), { worktreePath: tmpDir })

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

    await getStatusOp(git, streamGitFromCapture(git), { worktreePath: tmpDir })
    await getStatusOp(git, streamGitFromCapture(git), { worktreePath: tmpDir })

    expect(
      git.mock.calls.filter(([args]) => args[0] === 'rev-parse' && args.includes('HEAD@{u}'))
    ).toHaveLength(2)
  })
})
