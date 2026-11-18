import { expect, it } from 'vitest'
import { isSubmittedTerminalInput } from './terminal-input-submission'

it('counts Enter as a submission but not pasted or modified newlines', () => {
  expect(isSubmittedTerminalInput('/compact\r')).toBe(true)
  expect(isSubmittedTerminalInput('\r')).toBe(true)
  expect(isSubmittedTerminalInput('\x1b[200~draft\ncontinued\r\x1b[201~')).toBe(false)
  expect(isSubmittedTerminalInput('\x1b\r')).toBe(false)
  expect(isSubmittedTerminalInput('draft\n')).toBe(false)
})
