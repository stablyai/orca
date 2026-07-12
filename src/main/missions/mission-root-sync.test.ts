import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Mission } from '../../shared/types'
import { getLocalMissionMemberLinks } from './mission-root-sync'

const wtA = path.join(path.sep, 'wt', 'a')
const wtB = path.join(path.sep, 'wt', 'b')
const wtC = path.join(path.sep, 'wt', 'c')
const wtRemote = path.join(path.sep, 'wt', 'remote')

function makeMission(members: Mission['members']): Mission {
  return {
    id: 'm1',
    name: 'Referral',
    branchName: 'mission/referral',
    members,
    tabOrder: 0,
    rootPath: path.join(path.sep, 'home', 'u', 'orca', 'missions', 'referral'),
    createdAt: 1,
    updatedAt: 1
  }
}

const repos: Record<string, { id: string; displayName: string; connectionId?: string | null }> = {
  r1: { id: 'r1', displayName: 'Dashboard' },
  r2: { id: 'r2', displayName: 'Dashboard!' },
  r3: { id: 'r3', displayName: 'dashboard' },
  ssh: { id: 'ssh', displayName: 'Remote', connectionId: 'ssh-1' }
}

const fakeStore = {
  getRepo: (id: string) => repos[id] ?? null
} as never

describe('getLocalMissionMemberLinks', () => {
  it('keeps a distinct link per member when sanitized names collide', () => {
    const links = getLocalMissionMemberLinks(
      fakeStore,
      makeMission([
        { repoId: 'r1', worktreeId: `r1::${wtA}`, addedAt: 1 },
        { repoId: 'r2', worktreeId: `r2::${wtB}`, addedAt: 1 },
        { repoId: 'r3', worktreeId: `r3::${wtC}`, addedAt: 1 }
      ])
    )
    expect(links).toEqual([
      { name: 'dashboard', targetPath: wtA },
      { name: 'dashboard-2', targetPath: wtB },
      { name: 'dashboard-3', targetPath: wtC }
    ])
  })

  it('skips ssh members and members without worktrees', () => {
    const links = getLocalMissionMemberLinks(
      fakeStore,
      makeMission([
        { repoId: 'ssh', worktreeId: `ssh::${wtRemote}`, addedAt: 1 },
        { repoId: 'r1', worktreeId: null, addedAt: 1 },
        { repoId: 'r2', worktreeId: `r2::${wtB}`, addedAt: 1 }
      ])
    )
    expect(links).toEqual([{ name: 'dashboard', targetPath: wtB }])
  })
})
