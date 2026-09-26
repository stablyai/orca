import { describe, expect, it } from 'vitest'
import {
  gitCommonDirForMainProcess,
  objectPackBaseForGit,
  objectsDirectoryForMainProcess,
  refsDirectoryForMainProcess
} from './git-common-dir-paths'

const WSL_COMMON_DIR = '/home/dev/repo/.git'
const WSL_UNC = '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo\\.git'

describe('paths the main process opens', () => {
  it('joins a native POSIX common dir as POSIX', () => {
    expect(refsDirectoryForMainProcess('/repo/.git', undefined)).toBe('/repo/.git/refs')
    expect(objectsDirectoryForMainProcess('/repo/.git', undefined)).toBe('/repo/.git/objects')
    expect(gitCommonDirForMainProcess('/repo/.git', undefined)).toBe('/repo/.git')
  })

  it('joins a native Windows common dir as Windows', () => {
    // Decided by path syntax rather than by platform, so this holds on any host.
    expect(refsDirectoryForMainProcess('C:\\repo\\.git', undefined)).toBe('C:\\repo\\.git\\refs')
    expect(objectsDirectoryForMainProcess('C:\\repo\\.git', undefined)).toBe(
      'C:\\repo\\.git\\objects'
    )
  })

  it('translates a WSL answer back to the UNC spelling before joining', () => {
    // Git answers in its own execution space. Choosing the path flavour before
    // the conversion would collapse a Linux answer to a relative path.
    expect(refsDirectoryForMainProcess(WSL_COMMON_DIR, 'Ubuntu')).toBe(`${WSL_UNC}\\refs`)
    expect(objectsDirectoryForMainProcess(WSL_COMMON_DIR, 'Ubuntu')).toBe(`${WSL_UNC}\\objects`)
    expect(gitCommonDirForMainProcess(WSL_COMMON_DIR, 'Ubuntu')).toBe(WSL_UNC)
  })

  it('leaves a WSL answer that already arrived as UNC alone', () => {
    expect(refsDirectoryForMainProcess(WSL_UNC, 'Ubuntu')).toBe(`${WSL_UNC}\\refs`)
  })
})

describe('paths a Git child opens', () => {
  it('keeps the pack base in Git execution space, not the main process one', () => {
    // A WSL child cannot open a UNC path, and a worktree's cwd is not where its
    // object store lives, so this has to stay absolute and untranslated.
    expect(objectPackBaseForGit(WSL_COMMON_DIR, 'loose')).toBe(
      '/home/dev/repo/.git/objects/pack/loose'
    )
    expect(objectPackBaseForGit('/repo/.git', 'loose')).toBe('/repo/.git/objects/pack/loose')
    expect(objectPackBaseForGit('C:\\repo\\.git', 'loose')).toBe(
      'C:\\repo\\.git\\objects\\pack\\loose'
    )
  })
})
