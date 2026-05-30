import { describe, expect, it } from 'vitest'
import { resolveLocalDroppedPathsForAgent } from './dropped-path-resolution'

describe('resolveLocalDroppedPathsForAgent', () => {
  it('translates dropped Windows paths for local WSL worktrees', () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    try {
      expect(
        resolveLocalDroppedPathsForAgent(
          [
            'C:\\Users\\alice\\Desktop\\notes.txt',
            '\\\\wsl.localhost\\Ubuntu\\home\\alice\\repo\\README.md'
          ],
          '\\\\wsl.localhost\\Ubuntu\\home\\alice\\repo'
        )
      ).toEqual(['/mnt/c/Users/alice/Desktop/notes.txt', '/home/alice/repo/README.md'])
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform)
      }
    }
  })

  it('leaves dropped paths unchanged for non-WSL worktrees', () => {
    const paths = ['C:\\Users\\alice\\Desktop\\notes.txt']

    expect(resolveLocalDroppedPathsForAgent(paths, 'C:\\Users\\alice\\repo')).toBe(paths)
  })
})
