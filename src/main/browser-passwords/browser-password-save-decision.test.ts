import { describe, expect, it } from 'vitest'
import { decideBrowserPasswordSave } from './browser-password-save-decision'

const saved = [
  { id: 'a', username: 'ada', password: 'one' },
  { id: 'b', username: 'grace', password: 'two' }
]

describe('decideBrowserPasswordSave', () => {
  it('offers a new save for an unknown username', () => {
    expect(
      decideBrowserPasswordSave({ username: 'linus', password: 'x', formKind: 'login', saved })
    ).toEqual({ kind: 'save', username: 'linus', password: 'x' })
  })

  it('only records a use for a known pair', () => {
    expect(
      decideBrowserPasswordSave({ username: 'ada', password: 'one', formKind: 'login', saved })
    ).toEqual({ kind: 'none', usedEntryId: 'a' })
  })

  it('offers an update when a known username signs in with a new password', () => {
    expect(
      decideBrowserPasswordSave({ username: ' ada ', password: 'new', formKind: 'login', saved })
    ).toEqual({ kind: 'update', entryId: 'a', username: 'ada', password: 'new' })
  })

  it('matches by password when the form has no username', () => {
    expect(
      decideBrowserPasswordSave({ username: null, password: 'two', formKind: 'login', saved })
    ).toEqual({ kind: 'none', usedEntryId: 'b' })
  })

  it('updates the only saved login from a change-password form without a username', () => {
    expect(
      decideBrowserPasswordSave({
        username: null,
        password: 'rotated',
        formKind: 'change',
        saved: [saved[0]]
      })
    ).toEqual({ kind: 'update', entryId: 'a', username: 'ada', password: 'rotated' })
  })

  it('saves without a username when nothing matches and the account is ambiguous', () => {
    expect(
      decideBrowserPasswordSave({ username: null, password: 'rotated', formKind: 'change', saved })
    ).toEqual({ kind: 'save', username: '', password: 'rotated' })
  })
})
