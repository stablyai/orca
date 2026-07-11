import { describe, expect, it } from 'vitest'
import type { Mission } from '../../shared/types'
import { getLocalMissionMemberLinks } from './mission-root-sync'

function makeMission(members: Mission['members']): Mission {
  return {
    id: 'm1',
    name: 'Referral',
    branchName: 'mission/referral',
    members,
    tabOrder: 0,
    rootPath: '/home/u/orca/missions/referral',
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
        { repoId: 'r1', worktreeId: 'r1::/wt/a', addedAt: 1 },
        { repoId: 'r2', worktreeId: 'r2::/wt/b', addedAt: 1 },
        { repoId: 'r3', worktreeId: 'r3::/wt/c', addedAt: 1 }
      ])
    )
    expect(links).toEqual([
      { name: 'dashboard', targetPath: '/wt/a' },
      { name: 'dashboard-2', targetPath: '/wt/b' },
      { name: 'dashboard-3', targetPath: '/wt/c' }
    ])
  })

  it('skips ssh members and members without worktrees', () => {
    const links = getLocalMissionMemberLinks(
      fakeStore,
      makeMission([
        { repoId: 'ssh', worktreeId: 'ssh::/wt/remote', addedAt: 1 },
        { repoId: 'r1', worktreeId: null, addedAt: 1 },
        { repoId: 'r2', worktreeId: 'r2::/wt/b', addedAt: 1 }
      ])
    )
    expect(links).toEqual([{ name: 'dashboard', targetPath: '/wt/b' }])
  })
})
