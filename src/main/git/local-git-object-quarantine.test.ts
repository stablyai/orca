import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GitObjectQuarantineModule from '../../shared/git-object-quarantine'
import type { GitObjectQuarantine, GitObjectsDirectory } from '../../shared/git-object-quarantine'
import {
  createLocalGitObjectQuarantine,
  inheritedLocalObjectStore,
  localGitObjectQuarantineProcessEnv,
  localGitObjectsDirectory
} from './local-git-object-quarantine'
import {
  resetWslLinkedWorktreeGitRoutingForTests,
  seedWslLinkedWorktreeGitRoutingForTests
} from './wsl-linked-worktree-git-routing'

const { readRepoCommonDirFromGitMock } = vi.hoisted(() => ({
  readRepoCommonDirFromGitMock: vi.fn()
}))

vi.mock('./worktree-list-reader', () => ({
  readRepoCommonDirFromGit: readRepoCommonDirFromGitMock
}))
vi.mock('../../shared/git-object-quarantine', async (importOriginal) => ({
  ...(await importOriginal<typeof GitObjectQuarantineModule>()),
  // Why: hands the resolved objects dir straight to the command; these tests pin routing, not disk.
  createGitObjectQuarantine: (
    resolve: () => Promise<GitObjectsDirectory | undefined>
  ): GitObjectQuarantine => ({
    run: async (command) => {
      const objects = await resolve()
      return command(
        objects
          ? {
              GIT_OBJECT_DIRECTORY: `${objects.gitPath}/scratch`,
              GIT_ALTERNATE_OBJECT_DIRECTORIES: objects.gitPath
            }
          : undefined
      )
    }
  })
}))

const QUARANTINE = {
  GIT_OBJECT_DIRECTORY: '/home/me/repo/.git/objects/tmp_objdir-orca-merge-tree-x',
  GIT_ALTERNATE_OBJECT_DIRECTORIES: '/home/me/repo/.git/objects'
}

describe('localGitObjectQuarantineProcessEnv', () => {
  it('forwards both variables through WSLENV on Windows, keeping existing entries', () => {
    const env = localGitObjectQuarantineProcessEnv(QUARANTINE, 'win32', {
      PATH: 'C:\\bin',
      WSLENV: 'ORCA_X/u'
    })

    expect(env).toMatchObject({ PATH: 'C:\\bin', ...QUARANTINE })
    expect(env.WSLENV?.split(':')).toEqual([
      'ORCA_X/u',
      'GIT_OBJECT_DIRECTORY',
      'GIT_ALTERNATE_OBJECT_DIRECTORIES'
    ])
  })

  it('leaves WSLENV alone off Windows', () => {
    const env = localGitObjectQuarantineProcessEnv(QUARANTINE, 'darwin', { PATH: '/usr/bin' })

    expect(env).toEqual({ PATH: '/usr/bin', ...QUARANTINE })
  })
})

describe('localGitObjectsDirectory', () => {
  it('translates a WSL Git common dir into a path the Windows host can open', () => {
    expect(localGitObjectsDirectory('/home/me/repo/.git', 'Ubuntu')).toEqual({
      hostPath: '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo\\.git\\objects',
      gitPath: '/home/me/repo/.git/objects'
    })
  })

  it('hands WSL Git the drvfs spelling of a drive-path common dir (Git < 2.31 prints it relative)', () => {
    expect(localGitObjectsDirectory('C:\\repo\\.git', 'Ubuntu')).toEqual({
      hostPath: 'C:\\repo\\.git\\objects',
      gitPath: '/mnt/c/repo/.git/objects'
    })
    expect(localGitObjectsDirectory('/mnt/c/repo/.git', 'Ubuntu')).toEqual({
      hostPath: 'C:\\repo\\.git\\objects',
      gitPath: '/mnt/c/repo/.git/objects'
    })
  })

  it('uses one spelling for native Git', () => {
    expect(localGitObjectsDirectory('/Users/me/repo/.git', undefined)).toEqual({
      hostPath: '/Users/me/repo/.git/objects',
      gitPath: '/Users/me/repo/.git/objects'
    })
    expect(localGitObjectsDirectory('C:\\repo\\.git', undefined)).toEqual({
      hostPath: 'C:\\repo\\.git\\objects',
      gitPath: 'C:\\repo\\.git\\objects'
    })
  })
})

describe('createLocalGitObjectQuarantine on a Windows host', () => {
  const originalPlatform = process.platform

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    resetWslLinkedWorktreeGitRoutingForTests()
    readRepoCommonDirFromGitMock.mockReset()
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    resetWslLinkedWorktreeGitRoutingForTests()
  })

  const envSeenBy = (repoPath: string, options: { wslDistro?: string } = {}) =>
    createLocalGitObjectQuarantine(repoPath, options).run(async (env) => env)

  it('takes the distro from a WSL repo path and hands WSL Git the variables through WSLENV', async () => {
    readRepoCommonDirFromGitMock.mockResolvedValue('/home/me/repo/.git')

    const env = await envSeenBy('\\\\wsl.localhost\\Ubuntu\\home\\me\\repo')

    expect(env).toMatchObject({
      GIT_OBJECT_DIRECTORY: '/home/me/repo/.git/objects/scratch',
      GIT_ALTERNATE_OBJECT_DIRECTORIES: '/home/me/repo/.git/objects'
    })
    expect(env?.WSLENV?.split(':')).toEqual(
      expect.arrayContaining(['GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES'])
    )
  })

  it('hands WSL Git the drvfs spelling for a drive-path repo', async () => {
    readRepoCommonDirFromGitMock.mockResolvedValue('C:\\repo\\.git')

    const env = await envSeenBy('C:\\repo', { wslDistro: 'Ubuntu' })

    expect(env?.GIT_OBJECT_DIRECTORY).toBe('/mnt/c/repo/.git/objects/scratch')
  })

  it('runs unquarantined when a WSL-authored linked worktree routes to Windows Git', async () => {
    readRepoCommonDirFromGitMock.mockResolvedValue('/mnt/c/repo/.git')
    seedWslLinkedWorktreeGitRoutingForTests('C:\\wt')

    await expect(envSeenBy('C:\\wt', { wslDistro: 'Ubuntu' })).resolves.toBeUndefined()
  })
})

describe('inheritedLocalObjectStore', () => {
  const ALTERNATES = { GIT_ALTERNATE_OBJECT_DIRECTORIES: '/shared/objects' }

  it('passes native Git’s inherited alternates on and refuses an inherited object dir', () => {
    expect(inheritedLocalObjectStore(undefined, ALTERNATES, 'darwin')).toEqual({
      inheritedAlternates: '/shared/objects'
    })
    expect(
      inheritedLocalObjectStore(undefined, { GIT_OBJECT_DIRECTORY: 'C:\\objects' }, 'win32')
    ).toBeUndefined()
  })

  it('ignores Windows values WSLENV does not forward, since WSL Git never saw them', () => {
    expect(inheritedLocalObjectStore('Ubuntu', ALTERNATES, 'win32')).toEqual({})
    expect(
      inheritedLocalObjectStore(
        'Ubuntu',
        { WSLENV: 'GIT_OBJECT_DIRECTORY/p:GIT_ALTERNATE_OBJECT_DIRECTORIES' },
        'win32'
      )
    ).toEqual({})
    expect(
      inheritedLocalObjectStore('Ubuntu', { GIT_OBJECT_DIRECTORY: 'C:\\objects' }, 'win32')
    ).toEqual({})
  })

  it.each(['GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_OBJECT_DIRECTORY/p'])(
    'runs unquarantined when WSLENV forwards %s to WSL Git',
    (token) => {
      const env = {
        GIT_ALTERNATE_OBJECT_DIRECTORIES: 'C:\\shared',
        GIT_OBJECT_DIRECTORY: 'C:\\objects',
        WSLENV: `ORCA_X/u:${token}`
      }

      expect(inheritedLocalObjectStore('Ubuntu', env, 'win32')).toBeUndefined()
    }
  )
})
