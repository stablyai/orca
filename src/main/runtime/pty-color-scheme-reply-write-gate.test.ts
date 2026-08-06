import { afterEach, describe, expect, it } from 'vitest'
import {
  _resetPtyColorSchemeReplyGateForTest,
  clearPtyColorSchemeReplyGate,
  notePtyColorSchemeScanGap,
  observePtyMode2031Decision,
  observePtyOutputForColorSchemeProtocol,
  setPtyColorSchemeScanDelegated,
  shouldDropStalePtyColorSchemeReply
} from './pty-color-scheme-reply-write-gate'

const DARK_REPORT = '\x1b[?997;1n'
const LIGHT_REPORT = '\x1b[?997;2n'

afterEach(() => {
  _resetPtyColorSchemeReplyGateForTest()
})

describe('pty color-scheme reply write gate', () => {
  it('passes reports while the newest ingested chunk left the PTY subscribed', () => {
    observePtyOutputForColorSchemeProtocol('pty-1', 'prompt \x1b[?2031h')
    expect(shouldDropStalePtyColorSchemeReply('pty-1', DARK_REPORT)).toBe(false)
    expect(shouldDropStalePtyColorSchemeReply('pty-1', LIGHT_REPORT)).toBe(false)
  })

  it('drops a report once a newer chunk withdrew the subscription (#9993 fish prompt-accept race)', () => {
    // fish at command accept: h → responder decides to reply → l ingested by
    // main → the reply write arrives. The reply was correct for its chunk and
    // is stale by the time it reaches the PTY.
    observePtyOutputForColorSchemeProtocol('pty-1', '\x1b[?2031h')
    observePtyOutputForColorSchemeProtocol('pty-1', '\x1b[?2031l')
    expect(shouldDropStalePtyColorSchemeReply('pty-1', DARK_REPORT)).toBe(true)
    expect(shouldDropStalePtyColorSchemeReply('pty-1', LIGHT_REPORT)).toBe(true)
  })

  it('passes when main never observed any 2031 state for the PTY', () => {
    observePtyOutputForColorSchemeProtocol('pty-1', 'plain output, no escapes')
    expect(shouldDropStalePtyColorSchemeReply('pty-1', DARK_REPORT)).toBe(false)
    expect(shouldDropStalePtyColorSchemeReply('pty-untracked', DARK_REPORT)).toBe(false)
  })

  it('holds the previous verdict through an ambiguous split withdrawal, then drops', () => {
    observePtyOutputForColorSchemeProtocol('pty-1', '\x1b[?2031h')
    // Incomplete private-mode tail: no decision yet, prior subscribe stands.
    observePtyOutputForColorSchemeProtocol('pty-1', '\x1b[?20')
    expect(shouldDropStalePtyColorSchemeReply('pty-1', DARK_REPORT)).toBe(false)
    observePtyOutputForColorSchemeProtocol('pty-1', '31l')
    expect(shouldDropStalePtyColorSchemeReply('pty-1', DARK_REPORT)).toBe(true)
  })

  it('accepts authoritative decisions from the fact relay over a delegated scan', () => {
    setPtyColorSchemeScanDelegated('pty-1', true)
    // Gapped delivered bytes must not mint decisions while delegated.
    observePtyOutputForColorSchemeProtocol('pty-1', '\x1b[?2031l')
    observePtyMode2031Decision('pty-1', 'subscribed')
    expect(shouldDropStalePtyColorSchemeReply('pty-1', DARK_REPORT)).toBe(false)
    observePtyMode2031Decision('pty-1', 'unsubscribed')
    expect(shouldDropStalePtyColorSchemeReply('pty-1', DARK_REPORT)).toBe(true)
  })

  it('resumes raw scanning after delegation ends', () => {
    setPtyColorSchemeScanDelegated('pty-1', true)
    observePtyMode2031Decision('pty-1', 'unsubscribed')
    setPtyColorSchemeScanDelegated('pty-1', false)
    observePtyOutputForColorSchemeProtocol('pty-1', '\x1b[?2031h')
    expect(shouldDropStalePtyColorSchemeReply('pty-1', DARK_REPORT)).toBe(false)
  })

  it('a data gap resets the scan carry and fails the raw verdict open', () => {
    observePtyOutputForColorSchemeProtocol('pty-1', '\x1b[?2031h')
    // Half-open escape, then a gap: the carry must not resolve across it.
    observePtyOutputForColorSchemeProtocol('pty-1', '\x1b[?20')
    notePtyColorSchemeScanGap('pty-1')
    observePtyOutputForColorSchemeProtocol('pty-1', '31l')
    expect(shouldDropStalePtyColorSchemeReply('pty-1', DARK_REPORT)).toBe(false)
  })

  it('a gap clears an unsubscribed raw verdict — the gap may have hidden a ?2031h', () => {
    observePtyOutputForColorSchemeProtocol('pty-1', '\x1b[?2031l')
    expect(shouldDropStalePtyColorSchemeReply('pty-1', DARK_REPORT)).toBe(true)
    notePtyColorSchemeScanGap('pty-1')
    expect(shouldDropStalePtyColorSchemeReply('pty-1', DARK_REPORT)).toBe(false)
    // A fresh authoritative decision re-arms the gate.
    observePtyOutputForColorSchemeProtocol('pty-1', '\x1b[?2031l')
    expect(shouldDropStalePtyColorSchemeReply('pty-1', DARK_REPORT)).toBe(true)
  })

  it('a gap while delegated keeps the daemon-relayed verdict', () => {
    setPtyColorSchemeScanDelegated('pty-1', true)
    observePtyMode2031Decision('pty-1', 'unsubscribed')
    notePtyColorSchemeScanGap('pty-1')
    expect(shouldDropStalePtyColorSchemeReply('pty-1', DARK_REPORT)).toBe(true)
  })

  it('lets one report through per observed ?996n query even while unsubscribed', () => {
    // A DSR ?996n answer reuses the CSI 997 bytes; a one-shot query must be
    // answered regardless of mode-2031 subscription state.
    observePtyOutputForColorSchemeProtocol('pty-1', '\x1b[?2031l')
    observePtyOutputForColorSchemeProtocol('pty-1', 'prompt \x1b[?996n tail')
    expect(shouldDropStalePtyColorSchemeReply('pty-1', DARK_REPORT)).toBe(false)
    expect(shouldDropStalePtyColorSchemeReply('pty-1', DARK_REPORT)).toBe(true)
  })

  it('counts multiple ?996n queries in one chunk, including 8-bit CSI', () => {
    observePtyOutputForColorSchemeProtocol('pty-1', '\x1b[?2031l')
    observePtyOutputForColorSchemeProtocol('pty-1', '\x1b[?996n\x9b?996n')
    expect(shouldDropStalePtyColorSchemeReply('pty-1', DARK_REPORT)).toBe(false)
    expect(shouldDropStalePtyColorSchemeReply('pty-1', LIGHT_REPORT)).toBe(false)
    expect(shouldDropStalePtyColorSchemeReply('pty-1', DARK_REPORT)).toBe(true)
  })

  it('recognizes a ?996n query split across chunks', () => {
    observePtyOutputForColorSchemeProtocol('pty-1', '\x1b[?2031l')
    observePtyOutputForColorSchemeProtocol('pty-1', 'prompt \x1b[?99')
    observePtyOutputForColorSchemeProtocol('pty-1', '6n tail')
    expect(shouldDropStalePtyColorSchemeReply('pty-1', DARK_REPORT)).toBe(false)
    expect(shouldDropStalePtyColorSchemeReply('pty-1', DARK_REPORT)).toBe(true)
  })

  it('does not double-count a completed query held next to a following chunk', () => {
    observePtyOutputForColorSchemeProtocol('pty-1', '\x1b[?2031l')
    observePtyOutputForColorSchemeProtocol('pty-1', '\x1b[?996n')
    observePtyOutputForColorSchemeProtocol('pty-1', ' tail')
    expect(shouldDropStalePtyColorSchemeReply('pty-1', DARK_REPORT)).toBe(false)
    expect(shouldDropStalePtyColorSchemeReply('pty-1', DARK_REPORT)).toBe(true)
  })

  it('a gap discards a split ?996n query carry', () => {
    observePtyOutputForColorSchemeProtocol('pty-1', '\x1b[?99')
    notePtyColorSchemeScanGap('pty-1')
    observePtyOutputForColorSchemeProtocol('pty-1', '6n')
    observePtyOutputForColorSchemeProtocol('pty-1', '\x1b[?2031l')
    expect(shouldDropStalePtyColorSchemeReply('pty-1', DARK_REPORT)).toBe(true)
  })

  it('a delegation toggle discards a split ?996n query carry', () => {
    observePtyOutputForColorSchemeProtocol('pty-1', '\x1b[?99')
    setPtyColorSchemeScanDelegated('pty-1', true)
    observePtyOutputForColorSchemeProtocol('pty-1', '6n')
    observePtyMode2031Decision('pty-1', 'unsubscribed')
    expect(shouldDropStalePtyColorSchemeReply('pty-1', DARK_REPORT)).toBe(true)
  })

  it('ignores 996n text that is not a CSI query', () => {
    observePtyOutputForColorSchemeProtocol('pty-1', '\x1b[?2031l')
    observePtyOutputForColorSchemeProtocol('pty-1', 'echo 996n \x1b[996n')
    expect(shouldDropStalePtyColorSchemeReply('pty-1', DARK_REPORT)).toBe(true)
  })

  it('never touches writes that are not a standalone CSI 997 report', () => {
    observePtyOutputForColorSchemeProtocol('pty-1', '\x1b[?2031l')
    expect(shouldDropStalePtyColorSchemeReply('pty-1', 'ls -la\r')).toBe(false)
    // Bracketed paste of report-looking bytes is user input, not a reply.
    expect(shouldDropStalePtyColorSchemeReply('pty-1', `\x1b[200~${DARK_REPORT}\x1b[201~`)).toBe(
      false
    )
    // Reports batched with other bytes are not responder writes either.
    expect(shouldDropStalePtyColorSchemeReply('pty-1', `${DARK_REPORT}y\r`)).toBe(false)
  })

  it('re-subscribing after a withdrawal passes reports again', () => {
    observePtyOutputForColorSchemeProtocol('pty-1', '\x1b[?2031h\x1b[?2031l')
    observePtyOutputForColorSchemeProtocol('pty-1', '\x1b[?2031h')
    expect(shouldDropStalePtyColorSchemeReply('pty-1', DARK_REPORT)).toBe(false)
  })

  it('scopes state per PTY', () => {
    observePtyOutputForColorSchemeProtocol('pty-a', '\x1b[?2031l')
    observePtyOutputForColorSchemeProtocol('pty-b', '\x1b[?2031h')
    expect(shouldDropStalePtyColorSchemeReply('pty-a', DARK_REPORT)).toBe(true)
    expect(shouldDropStalePtyColorSchemeReply('pty-b', DARK_REPORT)).toBe(false)
  })

  it('clearing a PTY releases its verdict and pending query slots', () => {
    observePtyOutputForColorSchemeProtocol('pty-1', '\x1b[?2031l\x1b[?996n')
    clearPtyColorSchemeReplyGate('pty-1')
    expect(shouldDropStalePtyColorSchemeReply('pty-1', DARK_REPORT)).toBe(false)
  })

  it('caps pending query slots so a flood cannot bank unlimited passes', () => {
    observePtyOutputForColorSchemeProtocol('pty-1', '\x1b[?2031l')
    observePtyOutputForColorSchemeProtocol('pty-1', '\x1b[?996n'.repeat(16))
    for (let i = 0; i < 4; i += 1) {
      expect(shouldDropStalePtyColorSchemeReply('pty-1', DARK_REPORT)).toBe(false)
    }
    expect(shouldDropStalePtyColorSchemeReply('pty-1', DARK_REPORT)).toBe(true)
  })
})
