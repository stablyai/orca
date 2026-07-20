import path from 'node:path'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Mission } from '../../shared/types'

const ownershipMarkerMocks = vi.hoisted(() => ({
  hasMissionWorktreeOwnershipMarker: vi.fn(() => true)
}))

vi.mock('./mission-worktree-ownership-marker', () => ownershipMarkerMocks)
import {
  ensureMissionRootStrict,
  getLocalMissionMemberLinks,
  removeMissionRootIfPresent
} from './mission-root-sync'
import {
  readMissionWorktreeCreateIntent,
  writeMissionWorktreeCreateIntent
} from './mission-worktree-create-intent'

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

const worktreeMeta: Record<string, { missionId: string; instanceId: string }> = {
  [`r1::${wtA}`]: { missionId: 'm1', instanceId: 'instance-a' },
  [`r2::${wtB}`]: { missionId: 'm1', instanceId: 'instance-b' },
  [`r3::${wtC}`]: { missionId: 'm1', instanceId: 'instance-c' },
  [`ssh::${wtRemote}`]: { missionId: 'm1', instanceId: 'instance-remote' }
}

const fakeStore = {
  getRepo: (id: string) => repos[id] ?? null,
  getWorktreeMeta: (worktreeId: string) => worktreeMeta[worktreeId]
} as never

describe('getLocalMissionMemberLinks', () => {
  it('keeps a distinct link per owned member when sanitized names collide', () => {
    const links = getLocalMissionMemberLinks(
      fakeStore,
      makeMission([
        {
          repoId: 'r1',
          worktreeId: `r1::${wtA}`,
          worktreeInstanceId: 'instance-a',
          addedAt: 1
        },
        {
          repoId: 'r2',
          worktreeId: `r2::${wtB}`,
          worktreeInstanceId: 'instance-b',
          addedAt: 1
        },
        {
          repoId: 'r3',
          worktreeId: `r3::${wtC}`,
          worktreeInstanceId: 'instance-c',
          addedAt: 1
        }
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
        {
          repoId: 'ssh',
          worktreeId: `ssh::${wtRemote}`,
          worktreeInstanceId: 'instance-remote',
          addedAt: 1
        },
        { repoId: 'r1', worktreeId: null, worktreeInstanceId: null, addedAt: 1 },
        {
          repoId: 'r2',
          worktreeId: `r2::${wtB}`,
          worktreeInstanceId: 'instance-b',
          addedAt: 1
        }
      ])
    )
    expect(links).toEqual([{ name: 'dashboard', targetPath: wtB }])
  })

  it('fails closed when the worktree id belongs to another repo', () => {
    const crossRepoId = `r2::${wtB}`
    expect(
      getLocalMissionMemberLinks(
        fakeStore,
        makeMission([
          {
            repoId: 'r1',
            worktreeId: crossRepoId,
            worktreeInstanceId: 'instance-b',
            addedAt: 1
          }
        ])
      )
    ).toEqual([])
  })

  it('fails closed when mission or instance ownership does not match metadata', () => {
    const foreignMissionStore = {
      getRepo: (id: string) => repos[id] ?? null,
      getWorktreeMeta: () => ({ missionId: 'm2', instanceId: 'instance-a' })
    } as never
    const wrongInstanceStore = {
      getRepo: (id: string) => repos[id] ?? null,
      getWorktreeMeta: () => ({ missionId: 'm1', instanceId: 'replacement-instance' })
    } as never
    const member = {
      repoId: 'r1',
      worktreeId: `r1::${wtA}`,
      worktreeInstanceId: 'instance-a',
      addedAt: 1
    }

    expect(getLocalMissionMemberLinks(foreignMissionStore, makeMission([member]))).toEqual([])
    expect(getLocalMissionMemberLinks(wrongInstanceStore, makeMission([member]))).toEqual([])
  })

  it('fails closed when either the metadata or member instance stamp is missing', () => {
    const noMetaStore = {
      getRepo: (id: string) => repos[id] ?? null,
      getWorktreeMeta: () => undefined
    } as never

    expect(
      getLocalMissionMemberLinks(
        noMetaStore,
        makeMission([
          {
            repoId: 'r1',
            worktreeId: `r1::${wtA}`,
            worktreeInstanceId: 'instance-a',
            addedAt: 1
          }
        ])
      )
    ).toEqual([])
    expect(
      getLocalMissionMemberLinks(
        fakeStore,
        makeMission([
          {
            repoId: 'r1',
            worktreeId: `r1::${wtA}`,
            worktreeInstanceId: null,
            addedAt: 1
          }
        ])
      )
    ).toEqual([])
  })

  it('fails closed when the Git admin directory no longer carries the ownership marker', () => {
    ownershipMarkerMocks.hasMissionWorktreeOwnershipMarker.mockReturnValueOnce(false)

    expect(
      getLocalMissionMemberLinks(
        fakeStore,
        makeMission([
          {
            repoId: 'r1',
            worktreeId: `r1::${wtA}`,
            worktreeInstanceId: 'instance-a',
            addedAt: 1
          }
        ])
      )
    ).toEqual([])
  })

  it.skipIf(process.platform !== 'darwin')(
    'recognizes a direct child through the macOS private tmp alias',
    () => {
      const rootPath = '/tmp/orca-mission-root'
      const worktreePath = '/private/tmp/orca-mission-root/repo-one'
      const worktreeId = `r1::${worktreePath}`
      const mission = makeMission([
        {
          repoId: 'r1',
          worktreeId,
          worktreeInstanceId: 'instance-alias',
          addedAt: 1
        }
      ])
      mission.rootPath = rootPath
      const store = {
        getRepo: (id: string) => repos[id] ?? null,
        getWorktreeMeta: () => ({ missionId: 'm1', instanceId: 'instance-alias' })
      } as never

      expect(getLocalMissionMemberLinks(store, mission)).toEqual([])
    }
  )
})

describe('Mission root base persistence', () => {
  const cleanup: string[] = []

  afterEach(() => {
    for (const directory of cleanup.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('keeps an existing trusted root usable after workspaceDir changes', () => {
    const firstHome = mkdtempSync(path.join(os.tmpdir(), 'orca-mission-root-first-'))
    const secondHome = mkdtempSync(path.join(os.tmpdir(), 'orca-mission-root-second-'))
    cleanup.push(firstHome, secondHome)
    let workspaceDir = path.join(firstHome, 'workspaces')
    let mission = makeMission([])
    mission.rootPath = null
    const store = {
      getSettings: () => ({ workspaceDir }),
      getRepo: () => null,
      getWorktreeMeta: () => undefined,
      setMissionRootPath: (_id: string, rootPath: string, rootBasePath?: string | null) => {
        mission = { ...mission, rootPath, rootBasePath }
        return mission
      }
    } as never

    const created = ensureMissionRootStrict(store, mission)
    const originalRoot = created.rootPath
    const originalBase = created.rootBasePath
    workspaceDir = path.join(secondHome, 'workspaces')

    const reopened = ensureMissionRootStrict(store, created)
    expect(reopened.rootPath).toBe(originalRoot)
    expect(reopened.rootBasePath).toBe(originalBase)
    expect(removeMissionRootIfPresent(store, reopened)?.removed).toBe(true)
  })

  it('preserves an intent-only root until lifecycle recovery settles its proof', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'orca-mission-intent-root-'))
    cleanup.push(home)
    let mission = makeMission([{ repoId: 'r1', worktreeId: null, addedAt: 1 }])
    mission.rootPath = null
    const store = {
      getSettings: () => ({ workspaceDir: path.join(home, 'workspaces') }),
      getRepo: () => repos.r1,
      getWorktreeMeta: () => undefined,
      setMissionRootPath: (_id: string, rootPath: string, rootBasePath?: string | null) => {
        mission = { ...mission, rootPath, rootBasePath }
        return mission
      }
    } as never
    const rooted = ensureMissionRootStrict(store, mission)
    writeMissionWorktreeCreateIntent({
      root: {
        baseDir: rooted.rootBasePath!,
        rootPath: rooted.rootPath!,
        missionId: rooted.id
      },
      repoId: 'r1',
      branchName: rooted.branchName,
      worktreePath: path.join(rooted.rootPath!, 'repo-r1'),
      worktreeInstanceId: 'instance-r1',
      preserveBranchOnDelete: false
    })

    const result = removeMissionRootIfPresent(store, rooted)

    expect(result?.removed).toBe(false)
    expect(result?.preservedEntries).toHaveLength(1)
    expect(
      readMissionWorktreeCreateIntent(
        {
          baseDir: rooted.rootBasePath!,
          rootPath: rooted.rootPath!,
          missionId: rooted.id
        },
        'r1'
      )
    ).not.toBeNull()
  })

  it('does not erase add-complete proof during raw root cleanup', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'orca-mission-detached-root-'))
    cleanup.push(home)
    let mission = makeMission([{ repoId: 'r1', worktreeId: null, addedAt: 1 }])
    mission.rootPath = null
    const store = {
      getSettings: () => ({ workspaceDir: path.join(home, 'workspaces') }),
      getRepo: () => repos.r1,
      getWorktreeMeta: () => undefined,
      setMissionRootPath: (_id: string, rootPath: string, rootBasePath?: string | null) => {
        mission = { ...mission, rootPath, rootBasePath }
        return mission
      }
    } as never
    const rooted = ensureMissionRootStrict(store, mission)
    const worktreePath = path.join(rooted.rootPath!, 'repo-r1')
    writeMissionWorktreeCreateIntent({
      root: {
        baseDir: rooted.rootBasePath!,
        rootPath: rooted.rootPath!,
        missionId: rooted.id
      },
      repoId: 'r1',
      branchName: rooted.branchName,
      worktreePath,
      worktreeInstanceId: 'instance-r1',
      preserveBranchOnDelete: false
    })
    mkdirSync(worktreePath)

    const result = removeMissionRootIfPresent(store, rooted)

    expect(result?.removed).toBe(false)
    expect(result?.preservedEntries).toContain('repo-r1')
    expect(result?.preservedEntries).toHaveLength(2)
    expect(existsSync(worktreePath)).toBe(true)
    expect(
      readMissionWorktreeCreateIntent(
        {
          baseDir: rooted.rootBasePath!,
          rootPath: rooted.rootPath!,
          missionId: rooted.id
        },
        'r1'
      )
    ).not.toBeNull()
  })
})
