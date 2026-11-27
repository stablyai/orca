import { describe, expect, it } from 'vitest'
import { externalChromiumCommandArguments } from './external-chromium-command-arguments'

describe('externalChromiumCommandArguments browserExec', () => {
  it('keeps a quoted empty argument', () => {
    expect(
      externalChromiumCommandArguments('browserExec', { command: 'storage local set key ""' })
    ).toEqual(['storage', 'local', 'set', 'key', ''])
  })

  it('still refuses a batch step that agent-browser reads without its empty word', () => {
    expect(() =>
      externalChromiumCommandArguments('browserExec', { command: `batch 'set "" viewport 1 1'` })
    ).toThrow('set viewport')
  })

  it('does not make empty words from repeated spaces or quotes next to text', () => {
    expect(externalChromiumCommandArguments('browserExec', { command: 'a  ""x  b' })).toEqual([
      'a',
      'x',
      'b'
    ])
  })

  it('refuses an empty command word before a refused command', () => {
    expect(() =>
      externalChromiumCommandArguments('browserExec', { command: '"" tab new' })
    ).toThrow('empty command')
  })
})
