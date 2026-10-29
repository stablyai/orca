import { describe, expect, it } from 'vitest'
import type { Project } from '../shared/project-types'
import type { Repo } from '../shared/repo-types'
import {
  createProjectRuntimeGitRouter,
  type DotGitReader,
  type ProjectRuntimeGitRouterStore
} from './project-runtime-git-router'

function repo(id: string, path: string): Repo {
  return { id, path, displayName: id, badgeColor: '', addedAt: 0, kind: 'git' }
}

function project(id: string, preference?: Project['localWindowsRuntimePreference']): Project {
  return {
    id,
    displayName: id,
    badgeColor: '',
    sourceRepoIds: [id],
    createdAt: 0,
    updatedAt: 0,
    ...(preference ? { localWindowsRuntimePreference: preference } : {})
  }
}

function world() {
  const state = {
    repos: [
      repo('wsl', String.raw`C:\src\app`),
      repo('nested', String.raw`C:\src\app\vendor\lib`),
      repo('converted', String.raw`C:\src\fast`),
      { ...repo('remote', String.raw`C:\src\remote`), executionHostId: 'ssh:box' as const }
    ],
    projects: [
      project('wsl'),
      project('nested', { kind: 'windows-host' }),
      project('converted', { kind: 'wsl', distro: 'Ubuntu', git: 'windows-host' }),
      project('remote')
    ],
    worktreeMeta: new Map<string, unknown>([[String.raw`wsl::D:\trees\app-fix`, {}]])
  }
  const store: ProjectRuntimeGitRouterStore = {
    getRepos: () => state.repos,
    getProjects: () => state.projects,
    getSettings: () => ({ localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu' } }),
    getAllWorktreeMeta: () => Object.fromEntries(state.worktreeMeta)
  }
  // A null link is a main checkout's `.git` folder.
  const links = new Map<string, string | null>()
  const realpaths = new Map<string, string>()
  let walks = 0
  const readDotGit: DotGitReader = (folder) => {
    walks += 1
    const root = [...links.keys()].find((path) => folder.startsWith(path))
    return root ? { root, gitdir: links.get(root) ?? null } : null
  }
  const automountRoots = ['/mnt/']
  const router = createProjectRuntimeGitRouter(store, {
    readDotGit,
    realpath: (folder) => realpaths.get(folder) ?? null,
    automountRoots: () => automountRoots
  })
  return { state, router, links, realpaths, automountRoots, walks: () => walks }
}

describe('createProjectRuntimeGitRouter', () => {
  it("routes a project's folders and its known worktrees by its runtime", () => {
    const { router } = world()
    expect(router(String.raw`C:\src\app`)).toBe('Ubuntu')
    expect(router(String.raw`c:/SRC/app/src`)).toBe('Ubuntu')
    expect(router(String.raw`D:\trees\app-fix\pkg`)).toBe('Ubuntu')
  })

  it('keeps host Git for a converted project, a nested Windows project and unknown folders', () => {
    const { router } = world()
    expect(router(String.raw`C:\src\fast`)).toBeUndefined()
    expect(router(String.raw`C:\src\app\vendor\lib\x`)).toBeUndefined()
    expect(router(String.raw`C:\src\remote`)).toBeUndefined()
    expect(router(String.raw`C:\elsewhere`)).toBeUndefined()
  })

  it('takes a runtime switch on the very next call once the write drops the table', () => {
    const { state, router } = world()
    expect(router(String.raw`C:\src\app`)).toBe('Ubuntu')
    state.projects = state.projects.map((entry) =>
      entry.id === 'wsl'
        ? {
            ...entry,
            localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu', git: 'windows-host' }
          }
        : entry
    )
    router.invalidate()
    expect(router(String.raw`C:\src\app`)).toBeUndefined()
    state.projects = state.projects.map((entry) =>
      entry.id === 'converted'
        ? { ...entry, localWindowsRuntimePreference: { kind: 'wsl', distro: 'Debian' } }
        : entry
    )
    router.invalidate()
    expect(router(String.raw`C:\src\fast`)).toBe('Debian')
  })

  it('routes a worktree created a moment ago, before its metadata exists, by its .git link', () => {
    const { router, links } = world()
    links.set(String.raw`E:\new\feature`, 'C:/src/app/.git/worktrees/feature')
    expect(router(String.raw`E:\new\feature\src`)).toBe('Ubuntu')
    links.set(String.raw`E:\new\fast-wt`, 'C:/src/fast/.git/worktrees/fast-wt')
    expect(router(String.raw`E:\new\fast-wt`)).toBeUndefined()
  })

  it('rebuilds on a miss at most once per write, in case a write came without its event', () => {
    const { state, router } = world()
    expect(router(String.raw`C:\src\app`)).toBe('Ubuntu')
    state.repos = [...state.repos, repo('added', String.raw`F:\added`)]
    state.projects = [...state.projects, project('added')]
    expect(router(String.raw`F:\added\src`)).toBe('Ubuntu')
    state.repos = [...state.repos, repo('later', String.raw`H:\later`)]
    state.projects = [...state.projects, project('later')]
    expect(router(String.raw`H:\later`)).toBeUndefined()
    router.invalidate()
    expect(router(String.raw`H:\later`)).toBe('Ubuntu')
  })

  it('routes by the saved preference even when the distro is missing, so Git fails in WSL', () => {
    const { state, router } = world()
    state.projects = state.projects.map((entry) =>
      entry.id === 'wsl'
        ? { ...entry, localWindowsRuntimePreference: { kind: 'wsl', distro: 'Gone' } }
        : entry
    )
    router.invalidate()
    expect(router(String.raw`C:\src\app`)).toBe('Gone')
  })

  it('routes a worktree WSL Git made, whose link is the distro view of the drive', () => {
    const { router, links } = world()
    links.set(String.raw`E:\new\wsl-made`, '/mnt/c/src/app/.git/worktrees/wsl-made')
    expect(router(String.raw`E:\new\wsl-made\pkg`)).toBe('Ubuntu')
    links.set(String.raw`E:\new\relative`, '../../src/app/.git/worktrees/relative')
    links.set(String.raw`C:\x\y`, '../../src/app/.git/worktrees/relative')
    expect(router(String.raw`C:\x\y`)).toBe('Ubuntu')
    links.set(String.raw`E:\new\in-distro`, '/home/me/app/.git/worktrees/in-distro')
    expect(router(String.raw`E:\new\in-distro`)).toBeUndefined()
    links.set(String.raw`E:\new\unc`, '//wsl.localhost/Ubuntu/home/me/app/.git/worktrees/unc')
    expect(router(String.raw`E:\new\unc`)).toBeUndefined()
  })

  it('routes a main checkout reached through a symlink, junction or subst drive by its real folder', () => {
    const { router, links, realpaths } = world()
    links.set(String.raw`S:\app`, null)
    realpaths.set(String.raw`S:\app`, String.raw`C:\src\app`)
    expect(router(String.raw`S:\app\src`)).toBe('Ubuntu')
  })

  it('traces each unknown folder once per write, and again after the next write', () => {
    const { router, walks } = world()
    router(String.raw`G:\scratch`)
    router(String.raw`G:\scratch`)
    expect(walks()).toBe(1)
    router.invalidate()
    router(String.raw`G:\scratch`)
    expect(walks()).toBe(2)
  })

  it("maps a link under a distro's custom mount root into a known WSL project's drive tree", () => {
    const { router, links, automountRoots } = world()
    links.set(String.raw`E:\new\rooted`, '/c/src/app/.git/worktrees/rooted')
    // `[automount] root=/` not read yet: the link names no known project.
    expect(router(String.raw`E:\new\rooted`)).toBeUndefined()
    automountRoots.push('/')
    router.invalidate()
    expect(router(String.raw`E:\new\rooted`)).toBe('Ubuntu')
    // Under that root, a path that maps to no project's drive tree still routes nothing.
    links.set(String.raw`E:\new\elsewhere`, '/c/other/.git/worktrees/elsewhere')
    expect(router(String.raw`E:\new\elsewhere`)).toBeUndefined()
  })

  it('names the distros its projects run Git in, for reading their mount roots', () => {
    const { router } = world()
    expect(router.distros()).toEqual(['Ubuntu'])
  })
})
