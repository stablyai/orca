import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../shared/repo-types'
import { bumpLocalWorktreeScanGeneration } from './local-worktree-scan-generation'
import {
  _resetWorktreeCatalogOwnerForTests,
  invalidateWorktreeCatalogForRepoPath,
  isCurrentWorktreeCatalogObservation,
  readWorktreeCatalog
} from './repo-worktree-catalog-owner'
import type { WorktreeCatalogFlightPlan } from './repo-worktree-catalog-observation'

const repo: Repo = {
  id: 'slow-repo',
  path: '/repos/slow',
  kind: 'git',
  displayName: 'Slow repo',
  badgeColor: '#000000',
  addedAt: 0
}
const desktop = { kind: 'desktop', maxAgeMs: 5_000 } as const

function slowListing(): WorktreeCatalogFlightPlan {
  return {
    scan: async () => {
      vi.advanceTimersByTime(6_000)
      return { kind: 'rows', worktrees: [] }
    }
  }
}

beforeEach(() => vi.useFakeTimers({ toFake: ['Date'] }))
afterEach(() => {
  _resetWorktreeCatalogOwnerForTests()
  vi.useRealTimers()
})

describe('completed catalog reuse', () => {
  it('briefly reuses a slow successful listing but never slides the window on reads', async () => {
    const plan = slowListing()
    const first = await readWorktreeCatalog(repo, 'local', desktop, plan)
    for (let index = 0; index < 5; index += 1) {
      expect((await readWorktreeCatalog(repo, 'local', desktop, plan)).observation).toBe(
        first.observation
      )
    }
    vi.advanceTimersByTime(4_000)
    expect((await readWorktreeCatalog(repo, 'local', desktop, plan)).observation).toBe(
      first.observation
    )
    vi.advanceTimersByTime(1_001)

    expect((await readWorktreeCatalog(repo, 'local', desktop, plan)).observation).not.toBe(
      first.observation
    )
    expect(isCurrentWorktreeCatalogObservation(first.observation!)).toBe(false)
  })

  it('coalesces ten slow readers and still obeys a stricter reader’s freshness demand', async () => {
    const plan = slowListing()
    const reads = await Promise.all(
      Array.from({ length: 10 }, () => readWorktreeCatalog(repo, 'local', desktop, plan))
    )
    expect(reads.every((read) => read.observation === reads[0].observation)).toBe(true)
    vi.advanceTimersByTime(2)

    const fresh = await readWorktreeCatalog(repo, 'local', { ...desktop, maxAgeMs: 1 }, plan)
    expect(fresh.observation).not.toBe(reads[0].observation)
  })

  it('does not stamp a mutation during the scan as observed at completion', async () => {
    const plan = slowListing()
    const scan = plan.scan
    plan.scan = async () => {
      const outcome = await scan()
      invalidateWorktreeCatalogForRepoPath(repo.path)
      return outcome
    }
    const overtaken = await readWorktreeCatalog(repo, 'local', desktop, plan)
    expect(overtaken.superseded).toBe(true)
    expect(isCurrentWorktreeCatalogObservation(overtaken.observation!)).toBe(false)

    const current = await readWorktreeCatalog(repo, 'local', desktop, slowListing())
    expect(current.superseded).toBe(false)
    expect(current.observation).not.toBe(overtaken.observation)
  })

  it('withdraws completion reuse when a local generation changes', async () => {
    const plan = slowListing()
    const first = await readWorktreeCatalog(repo, 'local', desktop, plan)
    bumpLocalWorktreeScanGeneration(repo.id)

    expect(isCurrentWorktreeCatalogObservation(first.observation!)).toBe(false)
    expect((await readWorktreeCatalog(repo, 'local', desktop, plan)).observation).not.toBe(
      first.observation
    )
  })

  it('keeps the full-list ceiling anchored to scan start even inside completion reuse', async () => {
    const plan = slowListing()
    const requirement = {
      kind: 'runtime',
      maxAgeMs: 30_000,
      verifier: { ceilingMs: 6_001, timeoutMs: 1_000, probe: () => Promise.resolve('same') }
    } as const
    const first = await readWorktreeCatalog(repo, 'local', requirement, plan)
    vi.advanceTimersByTime(2)

    expect((await readWorktreeCatalog(repo, 'local', requirement, plan)).observation).not.toBe(
      first.observation
    )
  })

  it('does not apply successful completion reuse to failures', async () => {
    const requirement = { ...desktop, reusesFailure: true }
    const failed = await readWorktreeCatalog(repo, 'local', requirement, {
      scan: async () => {
        vi.advanceTimersByTime(6_000)
        throw new Error('cancelled')
      }
    })
    expect(failed.observation?.outcome.kind).toBe('failed')

    const retry = await readWorktreeCatalog(repo, 'local', requirement, slowListing())
    expect(retry.observation?.outcome.kind).toBe('rows')
    expect(retry.observation).not.toBe(failed.observation)
  })
})
