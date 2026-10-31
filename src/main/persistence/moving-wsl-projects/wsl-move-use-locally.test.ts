import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WSL_HOSTS_INTERNAL_GATE_ENV } from '../../../shared/wsl-host-internal-gate'
import { wslMoveCutoverFixture } from '../__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { seedWslMoveCutover } from '../__fixtures__/wsl-mover/wsl-move-journal-seeding'
import { listWslMoveCutovers } from './wsl-move-cutover-journal'
import { resolveWslMoveFence } from './wsl-move-fence'
import { bringWslMovedProjectBack } from './wsl-move-use-locally'

let userDataPath: string
beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'wsl-move-use-locally-'))
  vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '1')
})
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(userDataPath, { recursive: true, force: true })
})

const hidden = (): ReadonlySet<string> => resolveWslMoveFence(userDataPath).hidden.repoIds

describe('bringWslMovedProjectBack', () => {
  it('drops the finished move, so its retained rows list here again', () => {
    seedWslMoveCutover(
      userDataPath,
      wslMoveCutoverFixture('move-1', 'retained', {}, { repoIds: ['repo-1', 'repo-2'] })
    )
    expect(hidden().has('repo-1')).toBe(true)

    expect(bringWslMovedProjectBack(userDataPath, { repoId: 'repo-1' })).toEqual({
      released: true,
      distro: 'Ubuntu',
      repoIds: ['repo-1', 'repo-2'],
      folderWorkspaceIds: []
    })
    expect(listWslMoveCutovers(userDataPath)).toEqual([])
    expect(hidden().size).toBe(0)
  })

  it('also releases a committed move whose desktop rewrite never finished', () => {
    seedWslMoveCutover(userDataPath, wslMoveCutoverFixture('move-1', 'destination-committed'))
    expect(bringWslMovedProjectBack(userDataPath, { repoId: 'repo-1' }).released).toBe(true)
    expect(hidden().size).toBe(0)
  })

  it('refuses a project no committed move took', () => {
    seedWslMoveCutover(userDataPath, wslMoveCutoverFixture('move-1', 'blobs-transferred'))
    expect(bringWslMovedProjectBack(userDataPath, { repoId: 'repo-1' })).toEqual({
      released: false,
      reason: 'not-moved'
    })
    expect(bringWslMovedProjectBack(userDataPath, { folderWorkspaceId: 'other' })).toEqual({
      released: false,
      reason: 'not-moved'
    })
    expect(listWslMoveCutovers(userDataPath)).toHaveLength(1)
  })

  it('refuses a move a later move of the same distro builds on', () => {
    seedWslMoveCutover(userDataPath, wslMoveCutoverFixture('move-1', 'retained'))
    seedWslMoveCutover(
      userDataPath,
      wslMoveCutoverFixture(
        'move-2',
        'retained',
        { supersedesMigrationId: 'move-1' },
        { repoIds: ['repo-9'] }
      )
    )
    expect(bringWslMovedProjectBack(userDataPath, { repoId: 'repo-1' })).toEqual({
      released: false,
      reason: 'superseded',
      // The refusal named no move, so nothing said what to bring back first.
      newerMove: { repoIds: ['repo-9'], folderWorkspaceIds: [] }
    })
    expect(hidden().has('repo-1')).toBe(true)
    // The newest one can go, and then the earlier one becomes the newest.
    expect(bringWslMovedProjectBack(userDataPath, { repoId: 'repo-9' }).released).toBe(true)
    expect(bringWslMovedProjectBack(userDataPath, { repoId: 'repo-1' }).released).toBe(true)
  })

  it('does nothing with the WSL hosts gate closed', () => {
    seedWslMoveCutover(userDataPath, wslMoveCutoverFixture('move-1', 'retained'))
    vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '')
    expect(bringWslMovedProjectBack(userDataPath, { repoId: 'repo-1' })).toEqual({
      released: false,
      reason: 'gated-off'
    })
    expect(listWslMoveCutovers(userDataPath)).toHaveLength(1)
  })
})
