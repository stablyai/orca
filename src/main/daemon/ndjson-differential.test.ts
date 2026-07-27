import { describe, expect, it } from 'vitest'
import { createNdjsonParser } from './ndjson'

// Reference: the pre-slice string-accumulator parser, inlined verbatim.
function createLegacyParser(
  onMessage: (msg: unknown) => void,
  onError?: (err: Error) => void,
  options: { maxLineBytes?: number } = {}
): { feed(chunk: string): void } {
  let buffer = ''
  let discarding = false
  const maxLineBytes = Math.max(1, options.maxLineBytes ?? 16 * 1024 * 1024)
  return {
    feed(chunk: string): void {
      let remaining = chunk
      while (remaining.length > 0) {
        const nl = remaining.indexOf('\n')
        const has = nl !== -1
        const segment = has ? remaining.slice(0, nl) : remaining
        remaining = has ? remaining.slice(nl + 1) : ''
        if (discarding) {
          if (has) {
            discarding = false
            buffer = ''
            continue
          }
          return
        }
        const next = buffer + segment
        if (Buffer.byteLength(next, 'utf8') > maxLineBytes) {
          onError?.(new Error('oversized'))
          buffer = ''
          if (!has) {
            discarding = true
            return
          }
          continue
        }
        buffer = next
        if (!has) return
        const line = buffer
        buffer = ''
        if (line.length === 0) continue
        try {
          onMessage(JSON.parse(line))
        } catch (e) {
          onError?.(e as Error)
        }
      }
    }
  }
}

function mulberry32(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const ESC = String.fromCharCode(0x1b)
// Astral-plane samples: emoji, math script capital, and a flag (two regional indicators).
const ALPHABET = [
  'a',
  'Z',
  ' ',
  `${ESC}[31m`,
  '漢',
  '\u{1f600}',
  '"',
  '\\',
  '\n',
  '\t',
  '/',
  '{',
  '}',
  '\u{1d4b3}',
  '\u{1f1ef}\u{1f1f5}'
]

describe('ndjson parser parity with the pre-slice accumulator', () => {
  it.each([0xc0ffee, 0xbadf00d, 0x5eed])(
    'matches message-for-message on randomized terminal traffic (seed %i)',
    (seed) => {
      const rand = mulberry32(seed)
      for (let trial = 0; trial < 2000; trial += 1) {
        const messages: unknown[] = []
        let wire = ''
        const msgCount = 1 + Math.floor(rand() * 4)
        for (let m = 0; m < msgCount; m += 1) {
          let s = ''
          const len = Math.floor(rand() * 40)
          for (let i = 0; i < len; i += 1) s += ALPHABET[Math.floor(rand() * ALPHABET.length)]
          const msg = { method: 'pty.data', params: { id: `pty-${m}`, data: s, seq: m } }
          messages.push(msg)
          wire += `${JSON.stringify(msg)}\n`
        }
        const chunks: string[] = []
        let cursor = 0
        while (cursor < wire.length) {
          const take = 1 + Math.floor(rand() * 12)
          chunks.push(wire.slice(cursor, cursor + take))
          cursor += take
        }
        const got: unknown[] = []
        const want: unknown[] = []
        const parser = createNdjsonParser((m) => got.push(m))
        const legacy = createLegacyParser((m) => want.push(m))
        for (const c of chunks) {
          parser.feed(c)
          legacy.feed(c)
        }
        expect(got).toEqual(want)
        expect(got).toEqual(messages)
      }
    }
  )

  it('reassembles a surrogate pair split across feed boundaries', () => {
    const got: unknown[] = []
    const parser = createNdjsonParser((m) => got.push(m))
    const wire = `${JSON.stringify({ data: '\u{1f600}' })}\n`
    // One UTF-16 code unit at a time — the worst case for byte accumulation.
    for (let index = 0; index < wire.length; index += 1) {
      parser.feed(wire[index])
    }
    expect(got).toEqual([{ data: '\u{1f600}' }])
  })

  it('clears a held surrogate half on reset', () => {
    const got: unknown[] = []
    const parser = createNdjsonParser((m) => got.push(m))
    parser.feed('{"data":"\ud83d')
    parser.reset()
    parser.feed(`${JSON.stringify({ data: 'plain' })}\n`)
    expect(got).toEqual([{ data: 'plain' }])
  })
})
