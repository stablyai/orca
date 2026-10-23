import { describe, expect, it } from 'vitest'
import { TerminalSubmitKeys } from './terminal-submit-keys'

describe('submit-key protocol state without prompt retention', () => {
  it('ignores paste newlines and modified Enter, across write boundaries', () => {
    const keys = new TerminalSubmitKeys()
    for (const chunk of [
      '\x1b[20',
      '0~first\rsecond',
      '\x1b[201',
      '~',
      '\x1b\r',
      '\x1b[13;2u',
      '\x1b[27;2;13~',
      '\n'
    ]) {
      keys.record(chunk, 'human')
    }
    expect(keys.take()).toBeUndefined()
    keys.record('\r', 'human')
    expect(keys.take()).toBe('human')
    expect(keys.take()).toBeUndefined()
  })
  it('S17: a separate human Escape cannot swallow a later program submit', () => {
    const keys = new TerminalSubmitKeys()
    keys.record('\r', 'human')
    keys.record('invented program draft', 'programmatic')
    keys.record('\x1b', 'human')
    keys.record('\r', 'programmatic')
    expect(keys.take()).toBe('programmatic')
  })
  it('recognizes human Enter after an interrupted paste without treating body newlines as submit', () => {
    const keys = new TerminalSubmitKeys()
    keys.record('\x1b[200~invented\rbody\x1b[20', 'human')
    expect(keys.take()).toBeUndefined()
    keys.interruptPaste()
    keys.record('\r', 'human')
    expect(keys.take()).toBe('human')
  })
  it.each(['13', '13;1'])(
    'accepts split unmodified kitty Enter %s and consumes only the latest submit author',
    (params) => {
      const keys = new TerminalSubmitKeys()
      keys.record(`\x1b[${params}`, 'programmatic')
      keys.record('u', 'human')
      keys.record('draft text', 'programmatic')
      expect(keys.take()).toBe('human')
      keys.record('\r', 'human')
      keys.record('\r', 'programmatic')
      expect(keys.take()).toBe('programmatic')
    }
  )
})
