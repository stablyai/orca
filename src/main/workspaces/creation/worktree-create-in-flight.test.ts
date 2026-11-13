import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  registerWorktreeChangeInvalidator,
  runWorktreeChangeInvalidators
} from '../../ipc/worktrees/listing/worktree-change-invalidators'
import { invalidateDetectedWorktreeScanCache } from '../../ipc/worktrees/listing/detected-worktree-scan-cache'
import { getWorktreeScanMutationRevision } from '../catalog/local-worktree-scan-generation'
import {
  holdInFlightWorktreeCreate,
  withoutInFlightWorktreeCreates
} from './worktree-create-in-flight'

const rows = [{ path: '/repo' }, { path: '/ws/new' }, { path: '/ws/other' }]

describe('withoutInFlightWorktreeCreates', () => {
  it('omits a held checkout from its own repo until released', async () => {
    const release = await holdInFlightWorktreeCreate('repo-a', '/ws/new', () => {})
    expect(withoutInFlightWorktreeCreates('repo-a', rows)).toEqual([
      { path: '/repo' },
      { path: '/ws/other' }
    ])
    expect(withoutInFlightWorktreeCreates('repo-b', rows)).toBe(rows)
    release()
    expect(withoutInFlightWorktreeCreates('repo-a', rows)).toBe(rows)
  })

  it('keeps a second hold on the same path after the first releases', async () => {
    const unregister = registerWorktreeChangeInvalidator(invalidateDetectedWorktreeScanCache)
    const invalidate = () => runWorktreeChangeInvalidators('repo-a')
    const releaseFirst = await holdInFlightWorktreeCreate('repo-a', '/ws/new', invalidate)
    const releaseSecond = await holdInFlightWorktreeCreate('repo-a', '/ws/new/', invalidate)
    const revision = getWorktreeScanMutationRevision()
    try {
      releaseFirst()
      expect(getWorktreeScanMutationRevision()).toBe(revision + 1)
      releaseFirst()
      expect(getWorktreeScanMutationRevision()).toBe(revision + 1)
      expect(withoutInFlightWorktreeCreates('repo-a', rows)).toHaveLength(2)
      releaseSecond()
      expect(getWorktreeScanMutationRevision()).toBe(revision + 2)
      expect(withoutInFlightWorktreeCreates('repo-a', rows)).toBe(rows)
    } finally {
      releaseFirst()
      releaseSecond()
      unregister()
    }
  })

  it('hides the real path Git lists under a symlinked workspace with missing parents', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-create-hold-'))
    let release = () => {}
    try {
      const actual = join(root, 'actual')
      const alias = join(root, 'alias')
      await mkdir(actual)
      await symlink(actual, alias, 'junction')
      const requested = join(alias, 'nested', 'new')
      release = await holdInFlightWorktreeCreate('repo-alias', requested, () => {})
      await mkdir(requested, { recursive: true })
      const canonical = await realpath(requested)
      const listed = [{ path: requested }, { path: canonical }, { path: join(actual, 'other') }]
      expect(withoutInFlightWorktreeCreates('repo-alias', listed)).toEqual([listed[2]])
      expect(withoutInFlightWorktreeCreates('other-repo', listed)).toBe(listed)
      release()
      expect(withoutInFlightWorktreeCreates('repo-alias', listed)).toBe(listed)
    } finally {
      release()
      await rm(root, { recursive: true, force: true })
    }
  })
})
