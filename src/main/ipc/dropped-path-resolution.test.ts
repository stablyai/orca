import { describe, expect, it } from 'vitest'
import { PASTE_PAYLOAD_CORPUS } from '../../shared/paste-payload-corpus'
import { resolveLocalDroppedPathsForAgent } from './dropped-path-resolution'

function getPastePayloadCorpusText(name: string): string {
  const entry = PASTE_PAYLOAD_CORPUS.find((item) => item.name === name)
  if (!entry) {
    throw new Error(`Missing paste payload corpus case: ${name}`)
  }
  return entry.text
}

function withWin32Platform<T>(callback: () => T): T {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  try {
    return callback()
  } finally {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  }
}

describe('resolveLocalDroppedPathsForAgent', () => {
  it('translates only target-readable Windows paths for local WSL worktrees', () => {
    const windowsPath = getPastePayloadCorpusText('Windows path with spaces')
    const sameDistroWslPath = getPastePayloadCorpusText('WSL UNC path')
    const otherDistroWslPath = '\\\\wsl.localhost\\Debian\\home\\user\\repo'
    const uncPath = getPastePayloadCorpusText('UNC path')
    const posixPath = getPastePayloadCorpusText('POSIX path with spaces')

    expect(
      withWin32Platform(() =>
        resolveLocalDroppedPathsForAgent(
          [windowsPath, sameDistroWslPath, otherDistroWslPath, uncPath, posixPath],
          '\\\\wsl.localhost\\Ubuntu-24.04\\home\\user\\repo'
        )
      )
    ).toEqual([
      '/mnt/c/Users/Name/My Project/file.txt',
      '/home/user/repo',
      otherDistroWslPath,
      uncPath,
      posixPath
    ])
  })

  it('translates same-distro legacy WSL UNC paths case-insensitively', () => {
    expect(
      withWin32Platform(() =>
        resolveLocalDroppedPathsForAgent(
          ['\\\\wsl$\\ubuntu-24.04\\home\\user\\repo\\README.md'],
          '\\\\wsl.localhost\\Ubuntu-24.04\\home\\user\\repo'
        )
      )
    ).toEqual(['/home/user/repo/README.md'])
  })

  it('leaves dropped paths unchanged for non-WSL worktrees', () => {
    const paths = ['C:\\Users\\alice\\Desktop\\notes.txt']

    expect(resolveLocalDroppedPathsForAgent(paths, 'C:\\Users\\alice\\repo')).toBe(paths)
  })
})
