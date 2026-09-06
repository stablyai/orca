import { describe, expect, it, vi } from 'vitest'
import {
  OrcaRuntimeService,
  listWorktrees,
  resolveWorktreeScanCacheTtlMs
} from '../orca-runtime-test-mocks.spec'
import { store } from '../orca-runtime-test-fixtures.spec'
import { bumpLocalWorktreeScanGeneration } from '../../local-worktree-scan-generation'

describe('resolveWorktreeScanCacheTtlMs', () => {
  const BASE_TTL_MS = 30_000
  const SCRATCH_TTL_MS = 5 * 60_000

  it('keeps the base TTL for ordinary local repos', () => {
    expect(
      resolveWorktreeScanCacheTtlMs({ path: '/Users/dev/projects/app', connectionId: '' })
    ).toBe(BASE_TTL_MS)
  })

  it('extends the TTL for agent-scratch repo roots', () => {
    expect(
      resolveWorktreeScanCacheTtlMs({
        path: '/Users/dev/.codex-tmp/foragent-capsule-b1-repo-zP9Az6',
        connectionId: ''
      })
    ).toBe(SCRATCH_TTL_MS)
    expect(
      resolveWorktreeScanCacheTtlMs({
        path: '/Users/dev/.claude/skills/obsidian-second-brain',
        connectionId: ''
      })
    ).toBe(SCRATCH_TTL_MS)
  })

  it('never extends the TTL for SSH repos', () => {
    // Why: scratch classification reads local path conventions; a remote path
    // that merely looks similar must keep normal freshness.
    expect(
      resolveWorktreeScanCacheTtlMs({
        path: '/home/dev/.codex-tmp/capsule',
        connectionId: 'ssh-1'
      })
    ).toBe(BASE_TTL_MS)
  })

  it('keeps a scratch repo scan cached past the base TTL while normal repos rescan', async () => {
    // Why: the whole fix lives in the cache-stamp call site; pin the wiring so
    // a revert to the flat TTL fails CI, not just the pure-function tests.
    vi.useFakeTimers()
    // Why: the shared listWorktrees stub keeps call history across this file's
    // tests; absolute counts need a clean baseline.
    vi.mocked(listWorktrees).mockClear()
    try {
      const scratchPath = '/tmp/.codex-tmp/capsule-a'
      const runtime = new OrcaRuntimeService({
        ...store,
        getRepos: () => [
          { id: 'repo-1', path: '/tmp/repo', displayName: 'repo', badgeColor: 'blue', addedAt: 1 },
          {
            id: 'repo-scratch',
            path: scratchPath,
            displayName: 'capsule',
            badgeColor: 'blue',
            addedAt: 1
          }
        ]
      } as never)
      const internals = runtime as unknown as { listResolvedWorktrees: () => Promise<unknown> }
      const scanCallsFor = (path: string): number =>
        vi.mocked(listWorktrees).mock.calls.filter((call) => call[0] === path).length

      await internals.listResolvedWorktrees()
      expect(scanCallsFor('/tmp/repo')).toBe(1)
      expect(scanCallsFor(scratchPath)).toBe(1)

      vi.advanceTimersByTime(BASE_TTL_MS + 1_000)
      await internals.listResolvedWorktrees()
      expect(scanCallsFor('/tmp/repo')).toBe(2)
      expect(scanCallsFor(scratchPath)).toBe(1)

      vi.advanceTimersByTime(SCRATCH_TTL_MS)
      await internals.listResolvedWorktrees()
      expect(scanCallsFor(scratchPath)).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('scans a repo registered after the last snapshot instead of answering from it', async () => {
    // Why: the fleet snapshot only covers the repos that existed when it ran, so for a full TTL it
    // reported a just-connected SSH host as having no worktrees at all — and callers that resolve a
    // workspace through it turned that gap into `skill-install-workspace-not-found`.
    vi.mocked(listWorktrees).mockClear()
    const addedPath = '/tmp/repo-registered-later'
    const repos = [
      { id: 'repo-1', path: '/tmp/repo', displayName: 'repo', badgeColor: 'blue', addedAt: 1 }
    ]
    const runtime = new OrcaRuntimeService({ ...store, getRepos: () => repos } as never)
    const internals = runtime as unknown as { listResolvedWorktrees: () => Promise<unknown> }
    const scanCallsFor = (path: string): number =>
      vi.mocked(listWorktrees).mock.calls.filter((call) => call[0] === path).length

    await internals.listResolvedWorktrees()
    expect(scanCallsFor(addedPath)).toBe(0)

    repos.push({
      id: 'repo-added',
      path: addedPath,
      displayName: 'added',
      badgeColor: 'blue',
      addedAt: 2
    })
    bumpLocalWorktreeScanGeneration('repo-added')

    await internals.listResolvedWorktrees()
    expect(scanCallsFor(addedPath)).toBe(1)
  })
})
