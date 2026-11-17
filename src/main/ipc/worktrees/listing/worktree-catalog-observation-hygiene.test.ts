import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import {
  _resetWorktreeCatalogOwnerForTests,
  readWorktreeCatalog
} from '../../../workspaces/catalog/repo-worktree-catalog-owner'
import { __resetLocalWorktreeMetadataPruneGateForTests } from '../../../workspaces/catalog/local-worktree-metadata-prune-gate'
import {
  needsWorktreeCatalogHygieneClaim,
  worktreeCatalogHygienePlan
} from './worktree-catalog-observation-hygiene'

vi.mock('../removal/registered-worktree-roots-cache', () => ({
  getRegisteredWorktreeRootsRevision: () => 0,
  registerWorktreeRootsForRepo: vi.fn()
}))

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the owner and hygiene plan read only these repo fields.
const repo = { id: 'repo-1', path: '/repos/app', kind: 'git' } as Repo

async function readFailing(times: number, claimsHygiene: boolean) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the expectation is only carried, never read, when every scan fails.
  const capture = vi.fn(() => ({}) as never)
  const store = { captureNativeLocalWorktreeMetadataScanExpectation: capture }
  for (let read = 0; read < times; read += 1) {
    await readWorktreeCatalog(
      repo,
      'local:default',
      {
        kind: 'desktop',
        maxAgeMs: 5_000,
        ...(claimsHygiene ? { needsHygieneClaim: needsWorktreeCatalogHygieneClaim(repo) } : {})
      },
      {
        scan: () => Promise.reject(new Error('fatal: not a git repository (permission denied)')),
        ...worktreeCatalogHygienePlan(store as never, repo, {}, claimsHygiene)
      }
    )
  }
  return capture.mock.calls.length
}

describe('worktree catalog observation hygiene', () => {
  afterEach(() => {
    _resetWorktreeCatalogOwnerForTests()
    __resetLocalWorktreeMetadataPruneGateForTests()
  })

  it('captures the whole-store expectation once per evidence, however often a failing repo is read', async () => {
    expect(await readFailing(5, true)).toBe(1)
    __resetLocalWorktreeMetadataPruneGateForTests()
    _resetWorktreeCatalogOwnerForTests()
    expect(await readFailing(50, true)).toBe(1)
  })

  it('never captures for readers that do not prune', async () => {
    expect(await readFailing(5, false)).toBe(0)
  })
})
