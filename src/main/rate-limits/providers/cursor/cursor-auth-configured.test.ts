import { expect, it } from 'vitest'
import { isCursorAuthConfigured } from './cursor-auth'

// The status bar shows Cursor while this is true. A keychain read that didn't answer says nothing
// about the login, so it must not hide Cursor as if it were signed out.
it('keeps Cursor configured while its sign-in cannot be checked', () => {
  expect(isCursorAuthConfigured({ status: 'unavailable', error: 'Keychain did not answer' })).toBe(
    true
  )
})

it('drops Cursor only when no sign-in exists', () => {
  expect(isCursorAuthConfigured({ status: 'missing' })).toBe(false)
})
