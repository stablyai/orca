import { describe, expect, it } from 'vitest'
import { ShellCommandMarkerScanner } from './shell-command-marker-scanner'
import { SHELL_COMMAND_MAX_CHARS } from './shell-command-marker-template'

const marker = (nonce: string, command: string): string =>
  `\x1b]777;orca-cmd;${nonce};${Buffer.from(command).toString('base64')}\x07`

describe('ShellCommandMarkerScanner', () => {
  it('strips a split trusted marker and preserves surrounding Unicode in order', () => {
    const scanner = new ShellCommandMarkerScanner('nonce')
    const row = marker('nonce', 'codex --model test')
    expect(scanner.accept(`🙂A${row.slice(0, 12)}`)).toEqual([{ kind: 'data', data: '🙂A' }])
    expect(scanner.accept(`${row.slice(12)}B`)).toEqual([
      {
        kind: 'command-started',
        rawLength: row.length,
        event: { agent: 'codex', trusted: true }
      },
      { kind: 'data', data: 'B' }
    ])
  })

  it('strips a nonce mismatch but marks the fact untrusted', () => {
    const row = marker('wrong', 'claude')
    expect(new ShellCommandMarkerScanner('expected').accept(row)).toEqual([
      {
        kind: 'command-started',
        rawLength: row.length,
        event: { agent: 'claude', trusted: false }
      }
    ])
  })

  it('strips an empty nonce marker when the authority cannot mint one', () => {
    const row = marker('', 'claude')
    expect(new ShellCommandMarkerScanner(null).accept(row)).toEqual([
      {
        kind: 'command-started',
        rawLength: row.length,
        event: { agent: 'claude', trusted: false }
      }
    ])
  })

  // Why this replaces the old byte-for-byte preservation: the row carries the nonce, and
  // nothing outside Orca's own wrapper may emit this private prefix, so forwarding an
  // undecodable row published the nonce into the pane's own stream.
  it('drops a malformed private candidate instead of republishing its nonce', () => {
    const malformed = '\x1b]777;orca-cmd;nonce;not_base64!\x07'
    expect(new ShellCommandMarkerScanner('nonce').accept(malformed)).toEqual([])
  })

  it('decodes a 4096-character multibyte command instead of leaking the marker', () => {
    const command = '\u6f22'.repeat(SHELL_COMMAND_MAX_CHARS)
    const row = marker('nonce', command)
    const items = new ShellCommandMarkerScanner('nonce').accept(row)
    expect(items.every((item) => item.kind === 'command-started')).toBe(true)
    expect(items.length).toBe(1)
  })

  it('releases an over-cap candidate but drops a later truncated private marker', () => {
    const scanner = new ShellCommandMarkerScanner('nonce')
    const unterminated = `\x1b]777;orca-cmd;nonce;${'A'.repeat(60_000)}`
    const truncatedPrivate = '\x1b]777;orca-cmd;private-nonce;Y29k'
    const items = scanner.accept(unterminated + truncatedPrivate)
    const data = items.map((item) => (item.kind === 'data' ? item.data : '')).join('')
    expect(data).toBe(unterminated)
    expect(scanner.drain()).toEqual({
      data: '',
      rawLength: truncatedPrivate.length,
      transformed: true
    })
  })

  it('reassembles byte-for-byte across every chunk split', () => {
    const row = marker('nonce', 'claude --resume')
    const stream = `before${row}after`
    for (let split = 1; split < stream.length; split += 1) {
      const scanner = new ShellCommandMarkerScanner('nonce')
      const items = [
        ...scanner.accept(stream.slice(0, split)),
        ...scanner.accept(stream.slice(split))
      ]
      const data = items.map((item) => (item.kind === 'data' ? item.data : '')).join('')
      expect({ split, text: data + scanner.drain().data }).toEqual({
        split,
        text: 'beforeafter'
      })
      expect({ split, facts: items.filter((item) => item.kind !== 'data').length }).toEqual({
        split,
        facts: 1
      })
    }

    const truncatedScanner = new ShellCommandMarkerScanner('nonce')
    truncatedScanner.accept('\x1b]777;orca-cmd;nonce;Y29k')
    expect(truncatedScanner.drain().data).toBe('')
  })

  it('emits null for a valid non-agent command', () => {
    const row = marker('nonce', 'git status')
    expect(new ShellCommandMarkerScanner('nonce').accept(row)).toEqual([
      {
        kind: 'command-started',
        rawLength: row.length,
        event: { agent: null, trusted: true }
      }
    ])
  })
})
