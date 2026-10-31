import { describe, expect, it } from 'vitest'
import { extractPartialEscapeTail } from '../../shared/terminal-partial-escape-tail'
import { parseAnsiControlSequence } from './terminal-ansi-normalization'

// Why this file: `terminal-escape-introducer.test.ts` checks the table against a restatement
// of its own ranges, and the partial-tail fuzz nets check the ESC gate and the fold property
// against an oracle that shares the same table -- so neither catches a wrong dispatch entry.
// These assert the observable consequence of each class instead, through both consumers.

const ESC = '\x1b'
const BEL = '\x07'

/** The dispatch as it stood before the table was shared (34790ce0843^), as an oracle. */
function expectedClass(
  code: number
): 'csi' | 'osc' | 'string' | 'intermediate' | 'execute' | 'final' {
  if (code === 0x5b) {
    return 'csi'
  }
  if (code === 0x5d) {
    return 'osc'
  }
  if (code === 0x50 || code === 0x58 || code === 0x5e || code === 0x5f) {
    return 'string'
  }
  if (code >= 0x20 && code <= 0x2f) {
    return 'intermediate'
  }
  if (code < 0x20 || code === 0x7f) {
    return 'execute'
  }
  return 'final'
}

describe('terminal escape dispatch, observed through both scanners', () => {
  it('gives each introducer class its own terminator across the whole BMP', () => {
    for (let code = 0; code <= 0xffff; code += 1) {
      if (code === 0x1b || code === 0x18 || code === 0x1a) {
        continue // ESC/CAN/SUB are intercepted before the dispatch; the fuzz nets cover them.
      }
      const opener = ESC + String.fromCharCode(code)
      switch (expectedClass(code)) {
        case 'csi':
          expect([code, extractPartialEscapeTail(`${opener}m`)]).toEqual([code, ''])
          expect([code, extractPartialEscapeTail(`${opener};1`)]).toEqual([code, `${opener};1`])
          break
        case 'osc':
          // BEL terminates an OSC...
          expect([code, extractPartialEscapeTail(`${opener}title${BEL}`)]).toEqual([code, ''])
          expect([code, extractPartialEscapeTail(`${opener}title${ESC}\\`)]).toEqual([code, ''])
          break
        case 'string':
          // ...but must NOT terminate a DCS/SOS/PM/APC string; only ST does.
          expect([code, extractPartialEscapeTail(`${opener}x${BEL}`)]).toEqual([
            code,
            `${opener}x${BEL}`
          ])
          expect([code, extractPartialEscapeTail(`${opener}x${ESC}\\`)]).toEqual([code, ''])
          break
        case 'intermediate':
          expect([code, extractPartialEscapeTail(`${opener}0`)]).toEqual([code, ''])
          expect([code, extractPartialEscapeTail(`${opener} `)]).toEqual([code, `${opener} `])
          break
        case 'execute':
          // The ESC stays pending: a C0 executes and DEL is ignored mid-sequence.
          expect([code, extractPartialEscapeTail(opener)]).toEqual([code, opener])
          break
        case 'final':
          expect([code, extractPartialEscapeTail(opener)]).toEqual([code, ''])
          break
      }
    }
  })

  it('routes the normalizer to the matching sequence scanner across the whole BMP', () => {
    for (let code = 0; code <= 0xffff; code += 1) {
      const opener = ESC + String.fromCharCode(code)
      const introducer = expectedClass(code)
      if (introducer === 'csi') {
        expect([code, parseAnsiControlSequence(`${opener}1A`, 0)]).toEqual([
          code,
          { kind: 'csi', final: 'A', params: '1', firstParam: 1, endIndex: 3 }
        ])
      } else if (introducer === 'osc') {
        expect([code, parseAnsiControlSequence(`${opener}0;t${BEL}`, 0)]).toEqual([
          code,
          { kind: 'other', endIndex: 5 }
        ])
        // An unterminated OSC is incomplete, not a two-byte sequence.
        expect([code, parseAnsiControlSequence(`${opener}0;t`, 0)]).toEqual([code, null])
      } else if (introducer === 'string') {
        expect([code, parseAnsiControlSequence(`${opener}x${ESC}\\`, 0)]).toEqual([
          code,
          { kind: 'other', endIndex: 4 }
        ])
        // BEL does not close it, so the sequence is still incomplete.
        expect([code, parseAnsiControlSequence(`${opener}x${BEL}`, 0)]).toEqual([code, null])
      } else {
        // Intermediates, C0/DEL and final bytes are all consumed as two-byte sequences here.
        expect([code, parseAnsiControlSequence(`${opener}zz`, 0)]).toEqual([
          code,
          { kind: 'other', endIndex: 1 }
        ])
      }
    }
  })

  it('reads a missing introducer as a two-byte sequence, at any index', () => {
    // `charCodeAt` past the end is NaN; it must not fall into csi/osc/string and start scanning.
    for (const value of ['', ESC, `x${ESC}`, 'abc']) {
      for (let index = -3; index <= value.length + 3; index += 1) {
        const parsed = parseAnsiControlSequence(value, index)
        expect([value, index, parsed]).toEqual([
          value,
          index,
          { kind: 'other', endIndex: index + 1 }
        ])
      }
    }
  })
})
