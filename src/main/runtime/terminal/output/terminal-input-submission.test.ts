import { expect, it } from 'vitest'
import { isSubmittedTerminalInput } from './terminal-input-submission'

it('counts Enter as a submission but not pasted or modified newlines', () => {
  expect(isSubmittedTerminalInput('\r')).toBe(true)
  expect(isSubmittedTerminalInput('/compact\r')).toBe(true)
  expect(isSubmittedTerminalInput('\x1b\r')).toBe(false)
  expect(isSubmittedTerminalInput('draft\n')).toBe(false)
  // Keystrokes merged while a write is in flight still carry their Enter.
  expect(isSubmittedTerminalInput('\x1b[A\r')).toBe(true)
  expect(isSubmittedTerminalInput('/compact\x1b[116;1:3u\r')).toBe(true)
  expect(isSubmittedTerminalInput('/compact\rnext')).toBe(true)
  // Each chunk of a large paste: its opening frame, a body ending in CR, a split closing frame.
  expect(isSubmittedTerminalInput('\x1b[200~')).toBe(false)
  expect(isSubmittedTerminalInput(`${'x'.repeat(16_383)}\r`)).toBe(false)
  expect(isSubmittedTerminalInput('\x1b[200~line\r\x1b[201~')).toBe(false)
  expect(isSubmittedTerminalInput('\x1b[')).toBe(false)
  expect(isSubmittedTerminalInput('201~')).toBe(false)
})
