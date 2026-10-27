import { describe, expect, it } from 'vitest'
import { shouldForwardHeadlessTerminalQueryReply } from './headless-terminal-query-reply-policy'

describe('shouldForwardHeadlessTerminalQueryReply', () => {
  const xtVersion = '\x1bP>|xterm.js(6.1.0-beta.287)\x1b\\'
  const oscColorReply = '\x1b]10;rgb:2e2e/3434/3434\x1b\\'

  it('suppresses XTVERSION for a hidden Grok terminal', () => {
    expect(shouldForwardHeadlessTerminalQueryReply('grok', xtVersion)).toBe(false)
  })

  it('keeps other Grok terminal query replies', () => {
    expect(shouldForwardHeadlessTerminalQueryReply('grok', '\x1b[?1;2c')).toBe(true)
  })

  it('keeps XTVERSION replies for other agents', () => {
    expect(shouldForwardHeadlessTerminalQueryReply('codex', xtVersion)).toBe(true)
  })

  it('suppresses OSC color replies for a hidden Jcode terminal', () => {
    expect(shouldForwardHeadlessTerminalQueryReply('jcode', oscColorReply)).toBe(false)
    expect(
      shouldForwardHeadlessTerminalQueryReply('jcode', '\x1b]11;rgb:ffff/ffff/ffff\x1b\\')
    ).toBe(false)
  })

  it('keeps non-color replies for a hidden Jcode terminal', () => {
    expect(shouldForwardHeadlessTerminalQueryReply('jcode', xtVersion)).toBe(true)
    expect(shouldForwardHeadlessTerminalQueryReply('jcode', '\x1b[?1;2c')).toBe(true)
  })

  it('keeps OSC color replies for other agents', () => {
    expect(shouldForwardHeadlessTerminalQueryReply('codex', oscColorReply)).toBe(true)
  })
})
