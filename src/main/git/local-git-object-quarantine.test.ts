import { describe, expect, it } from 'vitest'
import {
  localGitObjectQuarantineProcessEnv,
  localGitObjectsDirectory
} from './local-git-object-quarantine'

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
