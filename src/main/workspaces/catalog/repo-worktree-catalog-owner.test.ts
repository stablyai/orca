import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../shared/repo-types'
import type { GitWorktreeInfo } from '../../../shared/worktree/types'
import { bumpWorktreeScanGeneration } from '../../git/worktrees/catalog/worktree-scan-cache'
import {
  _resetWorktreeCatalogOwnerForTests,
  invalidateWorktreeCatalogForRepo,
  readWorktreeCatalog
} from './repo-worktree-catalog-owner'
import type {
  WorktreeCatalogFlightPlan,
  WorktreeCatalogOutcome
} from './repo-worktree-catalog-observation'

const repo = { id: 'repo-1', path: '/repos/app', kind: 'git' } as Repo
const row = (path: string): GitWorktreeInfo => ({
  path,
  head: 'abc',
  branch: 'refs/heads/main',
  isBare: false,
  isMainWorktree: path === '/repos/app'
})
const desktop = { kind: 'desktop', maxAgeMs: 5_000, overtakenFlights: 3 } as const
const runtime = {
  kind: 'runtime',
  maxAgeMs: 30_000,
  reusesFailure: true,
  overtakenFlights: 3
} as const

function scanner(outcomes: WorktreeCatalogOutcome[]) {
  let resolveNext: (() => void) | null = null
  const plan: WorktreeCatalogFlightPlan & { calls: number; gate: boolean; release: () => void } = {
    calls: 0,
    gate: false,
    release: () => resolveNext?.(),
    scan: async () => {
      const outcome = outcomes[Math.min(plan.calls, outcomes.length - 1)]
      plan.calls += 1
      if (plan.gate) {
        await new Promise<void>((resolve) => {
          resolveNext = resolve
        })
      }
      if (outcome.kind === 'failed') {
        throw outcome.error
      }
      return outcome
    }
  }
  return plan
}

const rows = (...paths: string[]): WorktreeCatalogOutcome => ({
  kind: 'rows',
  worktrees: paths.map(row)
})

describe('repo worktree catalog owner', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
  })
  afterEach(() => {
    _resetWorktreeCatalogOwnerForTests()
    vi.useRealTimers()
  })

  it('serves the sidebar and the runtime from one observation within each reader’s accepted age', async () => {
    const plan = scanner([rows('/repos/app'), rows('/repos/app', '/repos/app-feature')])

    await readWorktreeCatalog(repo, 'local:default', desktop, plan)
    vi.advanceTimersByTime(4_000)
    const runtimeRead = await readWorktreeCatalog(repo, 'local:default', runtime, plan)
    expect(plan.calls).toBe(1)
    expect(runtimeRead.observation.outcome).toEqual(rows('/repos/app'))

    vi.advanceTimersByTime(2_000)
    const sidebarRead = await readWorktreeCatalog(repo, 'local:default', desktop, plan)
    expect(plan.calls).toBe(2)
    expect(sidebarRead.observation.outcome).toEqual(rows('/repos/app', '/repos/app-feature'))
  })

  it('does not let a runtime verification stretch the sidebar past its 5 seconds', async () => {
    const plan = scanner([rows('/repos/app'), rows('/repos/app', '/repos/app-external')])
    const verifier = {
      ceilingMs: 300_000,
      timeoutMs: 1_000,
      probe: () => Promise.resolve('fingerprint-1')
    }
    await readWorktreeCatalog(repo, 'local:default', { ...runtime, verifier }, plan)
    vi.advanceTimersByTime(31_000)
    const verified = await readWorktreeCatalog(
      repo,
      'local:default',
      { ...runtime, verifier },
      plan
    )
    expect(plan.calls).toBe(1)
    expect(verified.observation.outcome).toEqual(rows('/repos/app'))

    const sidebar = await readWorktreeCatalog(repo, 'local:default', desktop, plan)

    expect(plan.calls).toBe(2)
    expect(sidebar.observation.outcome).toEqual(rows('/repos/app', '/repos/app-external'))
  })

  it('moves readers that joined an overtaken scan onto one trailing scan', async () => {
    const plan = scanner([rows('/repos/app'), rows('/repos/app', '/repos/app-new')])
    plan.gate = true
    const first = readWorktreeCatalog(repo, 'local:default', runtime, plan)
    const joined = readWorktreeCatalog(repo, 'local:default', desktop, plan)
    invalidateWorktreeCatalogForRepo(repo.id)
    plan.release()
    await vi.waitFor(() => expect(plan.calls).toBe(2))
    plan.release()

    for (const read of await Promise.all([first, joined])) {
      expect(read.superseded).toBe(false)
      expect(read.observation.outcome).toEqual(rows('/repos/app', '/repos/app-new'))
    }
    expect(plan.calls).toBe(2)
  })

  it('stops reusing settled rows after a Git-layer mutation of the repo path', async () => {
    const plan = scanner([rows('/repos/app'), rows('/repos/app', '/repos/app-added')])
    await readWorktreeCatalog(repo, 'local:default', runtime, plan)

    bumpWorktreeScanGeneration('/repos/app')
    const read = await readWorktreeCatalog(repo, 'local:default', runtime, plan)

    expect(plan.calls).toBe(2)
    expect(read.observation.outcome).toEqual(rows('/repos/app', '/repos/app-added'))
  })

  it('never lets a sidebar failure stop the runtime from listing', async () => {
    const plan = scanner([{ kind: 'failed', error: new Error('index.lock') }, rows('/repos/app')])
    const failed = await readWorktreeCatalog(repo, 'local:default', desktop, plan)
    expect(failed.observation.outcome.kind).toBe('failed')

    const read = await readWorktreeCatalog(repo, 'local:default', runtime, plan)

    expect(plan.calls).toBe(2)
    expect(read.observation.outcome).toEqual(rows('/repos/app'))
  })

  it('retires the old Git runtime so switching back lists again', async () => {
    const plan = scanner([
      rows('/repos/app'),
      rows('/repos/app'),
      rows('/repos/app', '/repos/app-new')
    ])
    await readWorktreeCatalog(repo, 'local:native', runtime, plan)
    await readWorktreeCatalog(repo, 'local:wsl:Ubuntu', runtime, plan)

    const back = await readWorktreeCatalog(repo, 'local:native', runtime, plan)

    expect(plan.calls).toBe(3)
    expect(back.observation.outcome).toEqual(rows('/repos/app', '/repos/app-new'))
  })

  it('returns an unclaimed hygiene claim when a newer observation replaces it', async () => {
    const release = vi.fn()
    const plan = {
      ...scanner([rows('/repos/app')]),
      captureWitness: () => ({ authorizedRootsRevision: 1, hygieneDue: true, release })
    }
    await readWorktreeCatalog(repo, 'local:default', desktop, plan)
    invalidateWorktreeCatalogForRepo(repo.id)

    await readWorktreeCatalog(repo, 'local:default', desktop, plan)

    expect(release).toHaveBeenCalledTimes(1)
  })
})
