import { expect, it } from 'vitest'
import { shouldForwardHeadlessTerminalQueryReply } from './headless-terminal-query-reply-policy'

const OSC11_REPLY = '\u001b]11;rgb:0a0a/0e0e/1414\u001b\\'

it('does not forward an OSC 11 color reply into an Antigravity composer', () => {
  expect(shouldForwardHeadlessTerminalQueryReply('antigravity', OSC11_REPLY)).toBe(false)
  expect(shouldForwardHeadlessTerminalQueryReply('antigravity', '\u001b[0m')).toBe(true)
  expect(shouldForwardHeadlessTerminalQueryReply('codex', OSC11_REPLY)).toBe(true)
})
