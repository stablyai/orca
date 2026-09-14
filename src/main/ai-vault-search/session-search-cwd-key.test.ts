import { expect, it } from 'vitest'
import { folderGroupKey } from '../../shared/ai-vault-session-filters'
import { cwdKey } from './session-search-file-records'

// The sidebar groups sessions by `folderGroupKey`, which is the shared
// normalizer under a `folder:` prefix. A hit's `cwd_key` has to be the same
// string, or joining an indexed hit to a sidebar group returns nothing.
const CASES: [name: string, cwd: string][] = [
  ['a POSIX path', '/repo/app'],
  ['a trailing slash', '/repo/app/'],
  ['a Windows drive', 'C:\\Users\\me\\repo'],
  ['a WSL interop mount', '/mnt/c/Users/me/repo'],
  ['a WSL UNC path', '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo'],
  ['the wsl$ alias for the same path', '//wsl$/Ubuntu/home/me/repo'],
  ['a Linux path from inside WSL', '/home/me/repo'],
  ['the filesystem root', '/']
]

it.each(CASES)('keys %s exactly as the sidebar does', (_name, cwd) => {
  expect(`folder:${cwdKey(cwd)}`).toBe(folderGroupKey(cwd))
})

it('keeps the root as a path rather than collapsing it to nothing', () => {
  // An empty key is indistinguishable from "no cwd", and the scope filter builds
  // its child prefix as `key + '/'`, which would be `//` for an empty key.
  expect(cwdKey('/')).toBe('/')
})

it('has no key for a session whose cwd the transcript never recorded', () => {
  expect(cwdKey(null)).toBeNull()
})

it('folds the two WSL UNC aliases onto one key', () => {
  expect(cwdKey('\\\\wsl.localhost\\Ubuntu\\home\\me\\repo')).toBe(
    cwdKey('//wsl$/ubuntu/home/me/repo')
  )
})
