import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalBoundedPayload } from '../../../shared/agent-session-journal-types'
import { codexItemBody } from '../../codex/codex-structured-item-translation'
import {
  boundInlineText,
  boundPayload,
  DEFAULT_JOURNAL_PAYLOAD_LIMITS
} from './journal-payload-bounds'

function previousBoundPayload(
  payload: string,
  inlineHeadBytes: number
): AgentJournalBoundedPayload {
  const buffer = Buffer.from(payload, 'utf8')
  const digest = createHash('sha256').update(payload, 'utf8').digest('hex')
  if (buffer.byteLength <= inlineHeadBytes) {
    return { head: payload, byteLength: buffer.byteLength, digest, truncated: false }
  }
  let end = inlineHeadBytes
  while (end > 0 && (buffer[end] & 0b1100_0000) === 0b1000_0000) {
    end -= 1
  }
  return {
    head: buffer.subarray(0, end).toString('utf8'),
    byteLength: buffer.byteLength,
    digest,
    truncated: true
  }
}

function expectPreviousBounds(payload: string, inlineHeadBytes: number): void {
  const previous = previousBoundPayload(payload, inlineHeadBytes)
  const limits = { inlineHeadBytes }
  expect(boundPayload(payload, limits)).toEqual(previous)
  expect(boundInlineText(payload, limits)).toEqual({
    bounded: previous,
    text: previous.truncated
      ? `${previous.head}\n[Orca: output truncated — ${previous.byteLength} bytes total, digest ${previous.digest.slice(0, 12)}]`
      : payload
  })
}

afterEach(() => vi.restoreAllMocks())

describe('journal payload allocation bounds', () => {
  it('bounds a large completed Codex command without encoding its full output into a Buffer', () => {
    const payload = 'x'.repeat(50 * 1024 * 1024)
    const digest = createHash('sha256').update(payload, 'utf8').digest('hex')
    const from = vi.spyOn(Buffer, 'from')
    const allocUnsafe = vi.spyOn(Buffer, 'allocUnsafe')
    const body = codexItemBody({
      type: 'commandExecution',
      id: 'command',
      status: 'completed',
      command: 'cat large.log',
      cwd: '/workspace',
      aggregatedOutput: payload,
      exitCode: 0
    })
    const encodedStringBytes = from.mock.calls.reduce(
      (largest, [value]) =>
        typeof value === 'string' ? Math.max(largest, Buffer.byteLength(value, 'utf8')) : largest,
      0
    )
    const largestAllocation = allocUnsafe.mock.calls.reduce(
      (largest, [bytes]) => Math.max(largest, bytes),
      0
    )
    vi.restoreAllMocks()

    if (body?.kind !== 'tool-call') {
      throw new Error('Completed command did not produce a tool-call journal body')
    }
    expect(body.state).toBe('completed')
    expect(body.input).toMatchObject({ command: 'cat large.log', cwd: '/workspace' })
    expect(body.output).toEqual({
      head: 'x'.repeat(DEFAULT_JOURNAL_PAYLOAD_LIMITS.inlineHeadBytes),
      byteLength: payload.length,
      digest,
      truncated: true
    })
    expect(encodedStringBytes).toBeLessThanOrEqual(DEFAULT_JOURNAL_PAYLOAD_LIMITS.inlineHeadBytes)
    expect(largestAllocation).toBeLessThanOrEqual(DEFAULT_JOURNAL_PAYLOAD_LIMITS.inlineHeadBytes)
  })

  it('preserves UTF-8 clipping, replacement characters, metadata and exotic byte limits', () => {
    const cap = DEFAULT_JOURNAL_PAYLOAD_LIMITS.inlineHeadBytes
    const payloads = [
      '',
      'ascii\n\0text',
      '日本語😀é',
      '\ud800',
      '\udc00',
      'a\ud800b\udc00c',
      'x'.repeat(cap),
      'x'.repeat(cap + 1),
      `${'x'.repeat(cap - 2)}😀tail`,
      `${'x'.repeat(cap - 3)}\ud800tail`,
      `${'x'.repeat(cap - 2)}\udc00tail`
    ]
    const limits = [0, 1, 2, 3, 4, 16, cap, cap + 1, -1, 1.5, Number.NaN, Infinity, -Infinity]
    for (const payload of payloads) {
      for (const limit of limits) {
        expectPreviousBounds(payload, limit)
      }
    }
    expect(boundPayload(`${'x'.repeat(cap - 3)}\ud800tail`, { inlineHeadBytes: cap }).head).toBe(
      `${'x'.repeat(cap - 3)}\ufffd`
    )
  })

  it('matches the previous byte bounds for mixed Unicode and surrogate boundaries', () => {
    let seed = 0x12_34_56_78
    const random = (): number => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0
      return seed
    }
    const units = ['x', '日本', '😀', '\ud800', '\udc00', '\n', '\0', 'é', ' ']
    for (let index = 0; index < 240; index += 1) {
      let base = ''
      for (let part = 0; part < 16; part += 1) {
        base += units[random() % units.length]
      }
      const payload = base.repeat(1 + (random() % 1_024)).slice(0, random() % 40_000)
      expectPreviousBounds(payload, random() % 16_400)
    }
  })
})
