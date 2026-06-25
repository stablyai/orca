import { afterEach, describe, expect, it, vi } from 'vitest'
import { extractLastOsc7Uri, extractOscScanTail } from './osc7-uri-extraction'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('OSC-7 URI extraction', () => {
  it('extracts BEL and ST terminated OSC-7 URIs', () => {
    expect(extractLastOsc7Uri('\x1b]7;file:///first\x07noise\x1b]7;file:///second\x1b\\')).toBe(
      'file:///second'
    )
  })

  it('recovers when abandoned incomplete OSC data is followed by a fresh URI', () => {
    expect(extractLastOsc7Uri('\x1b]7;file:///abandoned\x1b]7;file:///fresh\x07')).toBe(
      'file:///fresh'
    )
  })

  it('keeps only bounded incomplete OSC tail text', () => {
    const tail = extractOscScanTail(`\x1b]7;file:///${'x'.repeat(10_000)}`, 128)

    expect(tail).toHaveLength(128)
  })

  it('scans large pasted OSC-like output without regex iteration', () => {
    const execSpy = vi.spyOn(RegExp.prototype, 'exec')
    const data = `${'pasted \x1b]x;noise\x07 '.repeat(10_000)}\x1b]7;file:///repo\x07`

    expect(extractLastOsc7Uri(data)).toBe('file:///repo')
    expect(execSpy).not.toHaveBeenCalled()
  })
})
