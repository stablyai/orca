import { describe, expect, it } from 'vitest'
import { hermesActiveProfileName, hermesProfileNames } from './hermes-launch-profile-names'

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
