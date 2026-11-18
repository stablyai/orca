import { expect, it } from 'vitest'
import { isSubmittedTerminalInput } from './terminal-input-submission'

it('counts Enter as a submission but not pasted or modified newlines', () => {
  expect(isSubmittedTerminalInput('\r')).toBe(true)
  expect(isSubmittedTerminalInput('/compact\r')).toBe(true)
  expect(isSubmittedTerminalInput('\x1b\r')).toBe(false)
  expect(isSubmittedTerminalInput('draft\n')).toBe(false)
  // Each chunk of a large paste: its opening frame, a body ending in CR, a split closing frame.
  expect(isSubmittedTerminalInput('\x1b[200~')).toBe(false)
  expect(isSubmittedTerminalInput(`${'x'.repeat(16_383)}\r`)).toBe(false)
  expect(isSubmittedTerminalInput('\x1b[')).toBe(false)
  expect(isSubmittedTerminalInput('201~')).toBe(false)
})
