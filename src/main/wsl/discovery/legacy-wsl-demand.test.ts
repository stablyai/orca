import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../shared/repository/repo-types'
import type { Project } from '../../../shared/project/project-types'
import type { FolderWorkspace } from '../../../shared/folder-workspaces/folder-workspace-types'
import {
  filterToLegacyWslDemand,
  hasLegacyWslDemand,
  readLegacyWslDemand,
  type LegacyWslDemandStore
} from './legacy-wsl-demand'

function repo(id: string, path: string, extra: Partial<Repo> = {}): Repo {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the demand reader only touches id, path, kind and host fields.
  return { id, path, displayName: id, badgeColor: '', addedAt: 0, ...extra } as Repo
}

function store(args: {
  repos?: Repo[]
  projects?: Project[]
  folders?: Partial<FolderWorkspace>[]
  settings?: ReturnType<LegacyWslDemandStore['getSettings']>
}): LegacyWslDemandStore {
  return {
    getRepos: () => args.repos ?? [],
    getProjects: () => args.projects ?? [],
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the reader only touches folderPath and host fields.
    getFolderWorkspaces: () => (args.folders ?? []) as FolderWorkspace[],
    getSettings: () => args.settings ?? {}
  }
}

const noMappedDrives = (): null => null

describe('readLegacyWslDemand', () => {
  it('names no distro for Windows projects and WSL-host projects', () => {
    const demand = readLegacyWslDemand(
      store({
        repos: [
          repo('win', 'C:\\src\\app'),
          repo('host', '/home/u/app', { executionHostId: 'runtime:wsl-env' }),
          repo('ssh', '/srv/app', { connectionId: 'ssh-1' })
        ]
      }),
      noMappedDrives
    )
    expect(demand).toEqual({ distros: [], defaultDistro: false })
    expect(hasLegacyWslDemand(demand)).toBe(false)
  })

  it('names the distro of a WSL-share project, worktree folder or folder workspace', () => {
    const demand = readLegacyWslDemand(
      store({
        repos: [
          repo('a', '\\\\wsl.localhost\\Ubuntu\\home\\u\\a'),
          repo('b', 'C:\\src\\b', { worktreeBasePath: '\\\\wsl$\\Debian\\home\\u\\wt' })
        ],
        folders: [{ folderPath: '\\\\wsl.localhost\\Alpine\\home\\u\\notes' }]
      }),
      noMappedDrives
    )
    expect(demand.distros.sort()).toEqual(['Alpine', 'Debian', 'Ubuntu'])
    expect(demand.defaultDistro).toBe(false)
  })

  it('names the distro behind a drive letter mapped to its share', () => {
    const demand = readLegacyWslDemand(store({ repos: [repo('a', 'W:\\home\\u\\a')] }), (letter) =>
      letter === 'W' ? '\\\\wsl.localhost\\Ubuntu' : null
    )
    expect(demand.distros).toEqual(['Ubuntu'])
  })

  it('counts the default distro for WSL terminals with no distro chosen', () => {
    const demand = readLegacyWslDemand(
      store({ settings: { terminalWindowsShell: 'wsl.exe' } }),
      noMappedDrives
    )
    expect(demand).toEqual({ distros: [], defaultDistro: true })
  })
})

describe('filterToLegacyWslDemand', () => {
  it('keeps named distros case-insensitively and drops the rest', () => {
    expect(
      filterToLegacyWslDemand(
        ['ubuntu', 'Debian'],
        { distros: ['Ubuntu'], defaultDistro: false },
        null
      )
    ).toEqual(['ubuntu'])
  })

  it('keeps the default distro, or every candidate while the default is unknown', () => {
    const demand = { distros: [], defaultDistro: true }
    expect(filterToLegacyWslDemand(['Ubuntu', 'Debian'], demand, 'Debian')).toEqual(['Debian'])
    expect(filterToLegacyWslDemand(['Ubuntu', 'Debian'], demand, undefined)).toEqual([
      'Ubuntu',
      'Debian'
    ])
  })
})
