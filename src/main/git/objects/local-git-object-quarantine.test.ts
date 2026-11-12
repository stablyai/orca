import { describe, expect, it, vi } from 'vitest'
import type * as GitObjectQuarantineModule from '../../../shared/git/objects/git-object-quarantine'
import type {
  GitObjectQuarantine,
  GitObjectsDirectory
} from '../../../shared/git/objects/git-object-quarantine'
import { inheritedLocalObjectStore, localGitObjectsDirectory } from './local-git-object-quarantine'
import '../command-runner/host-routing/wsl-linked-worktree-git-routing'

const { readRepoCommonDirFromGitMock } = vi.hoisted(() => ({
  readRepoCommonDirFromGitMock: vi.fn()
}))

vi.mock('../worktrees/catalog/worktree-list-reader', () => ({
  readRepoCommonDirFromGit: readRepoCommonDirFromGitMock
}))
vi.mock('../../../shared/git/objects/git-object-quarantine', async (importOriginal) => ({
  ...(await importOriginal<typeof GitObjectQuarantineModule>()),
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
