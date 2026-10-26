import type {
  BROWSER_PASSWORDS_GUEST_CHANNELS,
  BROWSER_PASSWORDS_TO_GUEST_CHANNELS
} from '../shared/browser-passwords-types'

// Why literals: the sandboxed guest preload's `require` resolves only 'electron', so importing the
// shared constants would emit a chunk it cannot load. `satisfies` and the test pin them.
export const PRELOAD_BROWSER_PASSWORDS_GUEST_CHANNELS = {
  pageForms: 'browserPasswords:guest:pageForms',
  typed: 'browserPasswords:guest:typed',
  submitted: 'browserPasswords:guest:submitted',
  formGone: 'browserPasswords:guest:formGone',
  fieldFocused: 'browserPasswords:guest:fieldFocused',
  fieldBlurred: 'browserPasswords:guest:fieldBlurred',
  fillResult: 'browserPasswords:guest:fillResult'
} as const satisfies typeof BROWSER_PASSWORDS_GUEST_CHANNELS

export const PRELOAD_BROWSER_PASSWORDS_TO_GUEST_CHANNELS = {
  enable: 'browserPasswords:toGuest:enable',
  disable: 'browserPasswords:toGuest:disable',
  fill: 'browserPasswords:toGuest:fill'
} as const satisfies typeof BROWSER_PASSWORDS_TO_GUEST_CHANNELS
