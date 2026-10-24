import { describe, expect, it, vi } from 'vitest'
import {
  resolveProjectExecutionRuntime,
  type LocalWindowsRuntimePreference
} from '../../shared/project-execution-runtime'
import type { Project } from '../../shared/project-types'
import type { Repo } from '../../shared/repo-types'
import {
  convertWslDriveProjectToWindowsGit,
  previewWslDriveProjectWindowsGit,
  type WslDriveProjectDeps
} from './wsl-drive-project-windows-git'

const REPO_PATH = String.raw`C:\src\app`

function setup(
  options: {
    preference?: LocalWindowsRuntimePreference
    globalDistro?: string | null
    repo?: Partial<Repo>
    links?: string[]
    windowsAutocrlf?: string | null
    localAutocrlf?: string | null
    gitMissing?: boolean
    distros?: string[]
  } = {}
) {
  const project: Project = {
    id: 'p1',
    displayName: 'app',
    badgeColor: '#000',
    sourceRepoIds: ['r1'],
    createdAt: 0,
    updatedAt: 0,
    ...(options.preference ? { localWindowsRuntimePreference: options.preference } : {})
  }
  const repo: Repo = {
    id: 'r1',
    displayName: 'app',
    path: REPO_PATH,
    badgeColor: '#000',
    addedAt: 0,
    ...options.repo
  }
  const runWindowsGit = vi.fn(async (args: string[], _cwd: string) => {
    if (options.gitMissing) {
      throw Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' })
    }
    const key = args.join(' ')
    if (key === '--version') {
      return 'git version 2.47.1.windows.1\n'
    }
    if (key === 'rev-parse --git-common-dir') {
      return '.git\n'
    }
    const configValue =
      key === 'config --get core.autocrlf'
        ? options.windowsAutocrlf
        : key === 'config --local --get core.autocrlf'
          ? options.localAutocrlf
          : undefined
    if (configValue !== undefined) {
      if (configValue === null) {
        throw Object.assign(new Error('exit 1'), { code: 1 })
      }
      return `${configValue}\n`
    }
    return ''
  })
  const readWorktreeLinks = vi.fn(async () => options.links ?? [])
  const deps: WslDriveProjectDeps = {
    getProjects: () => [project],
    getRepos: () => [repo],
    resolveRuntime: (entry) =>
      resolveProjectExecutionRuntime({
        appPlatform: 'win32',
        projectId: entry.id,
        projectRuntimePreference: entry.localWindowsRuntimePreference,
        globalWindowsRuntimeDefault:
          options.globalDistro === undefined
            ? { kind: 'windows-host' }
            : { kind: 'wsl', distro: options.globalDistro },
        wslAvailable: true,
        availableWslDistros: options.distros ?? ['Ubuntu']
      }),
    runWindowsGit,
    readWorktreeLinks
  }
  return { deps, runWindowsGit, readWorktreeLinks }
}

describe('converting a WSL project on a Windows drive to Windows Git', () => {
  it('keeps WSL for terminals and switches only Git, for a project override', async () => {
    const { deps } = setup({ preference: { kind: 'wsl', distro: 'Ubuntu' } })
    await expect(
      convertWslDriveProjectToWindowsGit(deps, 'p1', { alignLineEndings: false })
    ).resolves.toEqual({
      ok: true,
      preference: { kind: 'wsl', distro: 'Ubuntu', git: 'windows-host' },
      alignedLineEndingRepoIds: []
    })
  })

  it('pins the global default distro on a project that inherits it', async () => {
    const { deps } = setup({ globalDistro: 'Ubuntu' })
    await expect(
      convertWslDriveProjectToWindowsGit(deps, 'p1', { alignLineEndings: false })
    ).resolves.toMatchObject({
      preference: { kind: 'wsl', distro: 'Ubuntu', git: 'windows-host' }
    })
  })

  it('refuses a repo with worktrees WSL Git made, naming them, and changes nothing', async () => {
    const { deps, runWindowsGit, readWorktreeLinks } = setup({
      preference: { kind: 'wsl', distro: 'Ubuntu' },
      links: [
        'C:/src/app-feature/.git',
        '/home/me/orca/workspaces/app/fix/.git',
        '/mnt/c/src/app-wsl/.git'
      ]
    })
    await expect(
      convertWslDriveProjectToWindowsGit(deps, 'p1', { alignLineEndings: true })
    ).resolves.toEqual({
      ok: false,
      blockers: [
        {
          kind: 'wsl-authored-worktrees',
          repoId: 'r1',
          paths: ['/home/me/orca/workspaces/app/fix', '/mnt/c/src/app-wsl']
        }
      ]
    })
    expect(readWorktreeLinks).toHaveBeenCalledWith(String.raw`C:\src\app\.git`)
    expect(runWindowsGit).not.toHaveBeenCalledWith(
      ['config', '--local', 'core.autocrlf', 'true'],
      REPO_PATH
    )
  })

  it.each([
    [
      'a folder inside the distro',
      { repo: { path: String.raw`\\wsl.localhost\Ubuntu\home\me\app` } },
      { kind: 'not-windows-drive', repoId: 'r1' }
    ],
    [
      'a worktree folder inside the distro',
      { repo: { worktreeBasePath: String.raw`\\wsl.localhost\Ubuntu\home\me\trees` } },
      { kind: 'worktree-folder-in-distro', repoId: 'r1' }
    ],
    ['no Windows Git', { gitMissing: true }, { kind: 'windows-git-missing' }]
  ])('refuses %s', async (_case, extra, blocker) => {
    const { deps } = setup({
      preference: { kind: 'wsl', distro: 'Ubuntu' },
      ...extra
    })
    await expect(previewWslDriveProjectWindowsGit(deps, 'p1')).resolves.toMatchObject({
      blockers: [blocker]
    })
    await expect(
      convertWslDriveProjectToWindowsGit(deps, 'p1', { alignLineEndings: false })
    ).resolves.toEqual({ ok: false, blockers: [blocker] })
  })

  it.each([
    ['a Windows runtime', { preference: { kind: 'windows-host' } as const }, 'not-wsl-runtime'],
    [
      'an already converted project',
      { preference: { kind: 'wsl', distro: 'Ubuntu', git: 'windows-host' } as const },
      'not-wsl-runtime'
    ],
    [
      'a distro that is gone',
      { preference: { kind: 'wsl', distro: 'Ubuntu' } as const, distros: ['Debian'] },
      'runtime-needs-repair'
    ]
  ])('has nothing to convert for %s', async (_case, extra, kind) => {
    const { deps } = setup(extra)
    await expect(previewWslDriveProjectWindowsGit(deps, 'p1')).resolves.toMatchObject({
      blockers: [{ kind }]
    })
  })

  it('writes autocrlf into the repo only when asked and Windows Git uses it', async () => {
    const asked = setup({
      preference: { kind: 'wsl', distro: 'Ubuntu' },
      windowsAutocrlf: 'true',
      localAutocrlf: null
    })
    await expect(
      convertWslDriveProjectToWindowsGit(asked.deps, 'p1', { alignLineEndings: true })
    ).resolves.toMatchObject({ ok: true, alignedLineEndingRepoIds: ['r1'] })
    expect(asked.runWindowsGit).toHaveBeenCalledWith(
      ['config', '--local', 'core.autocrlf', 'true'],
      REPO_PATH
    )

    const notAsked = setup({
      preference: { kind: 'wsl', distro: 'Ubuntu' },
      windowsAutocrlf: 'true',
      localAutocrlf: null
    })
    await convertWslDriveProjectToWindowsGit(notAsked.deps, 'p1', { alignLineEndings: false })
    const alreadySet = setup({
      preference: { kind: 'wsl', distro: 'Ubuntu' },
      windowsAutocrlf: 'true',
      localAutocrlf: 'false'
    })
    await convertWslDriveProjectToWindowsGit(alreadySet.deps, 'p1', { alignLineEndings: true })
    for (const { runWindowsGit } of [notAsked, alreadySet]) {
      expect(runWindowsGit).not.toHaveBeenCalledWith(
        ['config', '--local', 'core.autocrlf', 'true'],
        REPO_PATH
      )
    }
  })

  it('previews the line-ending settings the dialog offers to align', async () => {
    const { deps } = setup({
      preference: { kind: 'wsl', distro: 'Ubuntu' },
      windowsAutocrlf: 'true',
      localAutocrlf: null
    })
    await expect(previewWslDriveProjectWindowsGit(deps, 'p1')).resolves.toEqual({
      projectId: 'p1',
      distro: 'Ubuntu',
      repos: [{ repoId: 'r1', path: REPO_PATH, windowsAutocrlf: 'true', localAutocrlf: null }],
      blockers: []
    })
  })
})
