import { expect, it } from 'vitest'
import { bulkPathspecCommands } from './git-pathspec'

it.skipIf(process.platform === 'win32')(
  'preserves literal backslashes in Git-reported WSL paths',
  () => {
    expect(
      bulkPathspecCommands(
        ['diff-files', '--quiet', '--'],
        [String.raw`literal\name.txt`],
        '/tmp/repo',
        { wslDistro: 'Ubuntu' },
        'git'
      )
    ).toEqual([['diff-files', '--quiet', '--', String.raw`:(literal)literal\name.txt`]])
  }
)
