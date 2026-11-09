import { describe, expect, it } from 'vitest'
import { dedupeWorktreesByPath } from './worktree-path-comparison'

describe('dedupeWorktreesByPath', () => {
  it.each<NodeJS.Platform>(['darwin', 'linux', 'win32'])(
    'keeps WSL worktrees that differ only in tail case on %s',
    (platform) => {
      const ids = dedupeWorktreesByPath(
        [
          { id: 'upper', path: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\Feature' },
          { id: 'lower', path: '\\\\wsl$\\ubuntu\\home\\dev\\feature' },
          { id: 'alias', path: '//wsl$/UBUNTU/home/dev/feature' }
        ],
        platform
      ).map((worktree) => worktree.id)
      expect(ids).toEqual(['upper', 'lower'])
    }
  )
})
