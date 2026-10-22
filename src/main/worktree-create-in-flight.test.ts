import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  holdInFlightWorktreeCreate,
  withoutInFlightWorktreeCreates
} from './worktree-create-in-flight'

const rows = [{ path: '/repo' }, { path: '/ws/new' }, { path: '/ws/other' }]

describe('withoutInFlightWorktreeCreates', () => {
  it('omits a held checkout from its own repo until released', async () => {
    const release = await holdInFlightWorktreeCreate('repo-a', '/ws/new')
    expect(withoutInFlightWorktreeCreates('repo-a', rows)).toEqual([
      { path: '/repo' },
      { path: '/ws/other' }
    ])
    expect(withoutInFlightWorktreeCreates('repo-b', rows)).toBe(rows)
    release()
    expect(withoutInFlightWorktreeCreates('repo-a', rows)).toBe(rows)
  })

  it('keeps a second hold on the same path after the first releases', async () => {
    const releaseFirst = await holdInFlightWorktreeCreate('repo-a', '/ws/new')
    const releaseSecond = await holdInFlightWorktreeCreate('repo-a', '/ws/new/')
    releaseFirst()
    releaseFirst()
    expect(withoutInFlightWorktreeCreates('repo-a', rows)).toHaveLength(2)
    releaseSecond()
    expect(withoutInFlightWorktreeCreates('repo-a', rows)).toBe(rows)
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
      release = await holdInFlightWorktreeCreate('repo-alias', requested)
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
