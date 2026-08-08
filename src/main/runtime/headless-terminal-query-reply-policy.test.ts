import { describe, expect, it } from 'vitest'
import { shouldForwardHeadlessTerminalQueryReply } from './headless-terminal-query-reply-policy'

describe('shouldForwardHeadlessTerminalQueryReply', () => {
  const xtVersion = '\x1bP>|xterm.js(6.1.0-beta.287)\x1b\\'

  it('suppresses XTVERSION for a hidden Grok terminal', () => {
    expect(shouldForwardHeadlessTerminalQueryReply('grok', xtVersion)).toBe(false)
  })

  it('keeps other Grok terminal query replies', () => {
    expect(shouldForwardHeadlessTerminalQueryReply('grok', '\x1b[?1;2c')).toBe(true)
  })

  it('keeps XTVERSION replies for other agents', () => {
    expect(shouldForwardHeadlessTerminalQueryReply('codex', xtVersion)).toBe(true)
  })
})
