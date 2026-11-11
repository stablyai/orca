import { describe, expect, it } from 'vitest'
import { worktreePathComparisonKey } from './worktree-path-comparison-key'

// Retirement namespace keys persist these bytes; a change orphans saved retired names.
describe('worktreePathComparisonKey bytes', () => {
  it.each<[string, NodeJS.Platform, string]>([
    ['/home/dev/Repo/', 'linux', 'posix:/home/dev/Repo'],
    ['/home/dev/./a/../Repo', 'win32', 'posix:/home/dev/Repo'],
    ['/private/tmp/orca/feature', 'darwin', 'posix:/tmp/orca/feature'],
    ['/private/tmp', 'darwin', 'posix:/tmp'],
    ['/private/tmp/orca/feature', 'linux', 'posix:/private/tmp/orca/feature'],
    ['C:/Workspaces/Feature', 'darwin', 'windows:c:\\workspaces\\feature'],
    ['\\\\Server\\Share\\Feature', 'linux', 'windows:\\\\server\\share\\feature'],
    ['//server/share/Feature', 'darwin', 'windows:\\\\server\\share\\feature'],
    [
      '\\\\wsl.localhost\\Ubuntu\\home\\dev\\Feature',
      'win32',
      'windows:\\\\wsl.localhost\\ubuntu\\home\\dev\\feature'
    ]
  ])('keys %s on %s', (pathValue, platform, expected) => {
    expect(worktreePathComparisonKey(pathValue, platform)).toBe(expected)
  })
})
