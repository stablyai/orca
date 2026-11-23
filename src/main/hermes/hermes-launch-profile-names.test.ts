import { describe, expect, it } from 'vitest'
import {
  hermesActiveProfileName,
  hermesProfileNames,
  readServerDirNames
} from './hermes-launch-profile-names'

describe('hermesProfileNames', () => {
  it('keeps directory names that launch a named profile, sorted', () => {
    expect(hermesProfileNames(['work', 'default', 'zeta', 'alpha-1'])).toEqual([
      'alpha-1',
      'work',
      'zeta'
    ])
  })

  it('drops names outside Hermes profile grammar', () => {
    expect(hermesProfileNames(['default', 'Work', 'a;b', '.', ''])).toEqual([])
  })
})

describe('hermesActiveProfileName', () => {
  it('reads the sticky choice with its byte-order mark and whitespace', () => {
    expect(hermesActiveProfileName('work\n')).toBe('work')
    expect(hermesActiveProfileName('\ufeffwork')).toBe('work')
  })

  it('returns null for the root home and unreadable files', () => {
    expect(hermesActiveProfileName('default\n')).toBeNull()
    expect(hermesActiveProfileName('')).toBeNull()
    expect(hermesActiveProfileName(null)).toBeNull()
  })
})

describe('readServerDirNames', () => {
  it('reads the server browse reply, keeping only directories', () => {
    expect(
      readServerDirNames({
        resolvedPath: '/home/zxy/.hermes/profiles',
        entries: [
          { name: 'lain', isDirectory: true, isSymlink: false },
          { name: 'active_profile', isDirectory: false, isSymlink: false },
          { name: 3, isDirectory: true }
        ]
      })
    ).toEqual(['lain'])
  })

  it('lists nothing for an older host or a malformed reply', () => {
    expect(readServerDirNames(null)).toEqual([])
    expect(readServerDirNames({})).toEqual([])
    expect(readServerDirNames({ entries: 'lain' })).toEqual([])
    expect(readServerDirNames([{ name: 'lain', isDirectory: true }])).toEqual([])
  })
})
