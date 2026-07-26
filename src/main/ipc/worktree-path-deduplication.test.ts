import { describe, expect, it } from 'vitest'
import { areWorktreePathsEqual, dedupeWorktreesByPath } from './worktree-path-comparison'

function dedupeWithComparator<T extends { path: string }>(
  worktrees: readonly T[],
  platform: NodeJS.Platform
): T[] {
  const unique: T[] = []
  for (const worktree of worktrees) {
    if (!unique.some((existing) => areWorktreePathsEqual(existing.path, worktree.path, platform))) {
      unique.push(worktree)
    }
  }
  return unique
}

describe('dedupeWorktreesByPath', () => {
  it.each<NodeJS.Platform>(['darwin', 'linux', 'win32'])(
    'preserves the comparator result on %s',
    (platform) => {
      const worktrees = [
        { id: 'posix-upper', path: '/home/dev/Repo' },
        { id: 'posix-lower', path: '/home/dev/repo' },
        { id: 'windows-first', path: 'C:\\Workspaces\\Feature' },
        { id: 'windows-duplicate', path: 'c:/workspaces/feature' },
        { id: 'unc-first', path: '\\\\Server\\Share\\Feature' },
        { id: 'unc-duplicate', path: '//server/share/feature' },
        { id: 'temp-private', path: '/private/tmp/orca/feature' },
        { id: 'temp-short', path: '/tmp/orca/feature' },
        { id: 'relative-first', path: 'workspaces/feature' },
        { id: 'relative-duplicate', path: 'workspaces/./feature' }
      ]

      for (let offset = 0; offset < worktrees.length; offset += 1) {
        const rotated = [...worktrees.slice(offset), ...worktrees.slice(0, offset)]
        expect(dedupeWorktreesByPath(rotated, platform)).toEqual(
          dedupeWithComparator(rotated, platform)
        )
        const reversed = rotated.toReversed()
        expect(dedupeWorktreesByPath(reversed, platform)).toEqual(
          dedupeWithComparator(reversed, platform)
        )
      }
    }
  )

  it('reads each path once for a large unique list', () => {
    let pathReads = 0
    const worktrees = Array.from({ length: 1_000 }, (_, index) => ({
      get path(): string {
        pathReads += 1
        return `/workspaces/feature-${index}`
      }
    }))

    expect(dedupeWorktreesByPath(worktrees)).toHaveLength(1_000)
    expect(pathReads).toBe(1_000)
  })
})
