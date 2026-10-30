import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalBoundedPayload,
  type AgentJournalItemBody,
  type AgentJournalToolCallState
} from '../../../shared/agent-session-journal-types'
import { codexItemBody } from '../../codex/codex-structured-item-translation'
import {
  AGENT_SESSION_WIRE_PAYLOAD_HEAD_BYTES,
  agentJournalItemForWire
} from '../agent-session-wire/agent-session-item-wire-form'
import { boundInlineText, boundPayload, journalPayload } from './journal-payload-bounds'
import { createJournalReducerState } from './journal-reducer'
import { buildJournalItemRow, journalLifecycleBatchRowBuilder } from './journal-row-builders'

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
  it('saves a large Codex command whole and sends a client only its head, encoding only that', () => {
    const payload = 'x'.repeat(50 * 1024 * 1024)
    const body = codexItemBody({
      type: 'commandExecution',
      id: 'command',
      status: 'completed',
      command: 'cat large.log',
      cwd: '/workspace',
      aggregatedOutput: payload,
      exitCode: 0
    })
    if (body?.kind !== 'tool-call') {
      throw new Error('Completed command did not produce a tool-call journal body')
    }
    expect(body.output).toMatchObject({
      head: payload,
      byteLength: payload.length,
      truncated: false
    })

    const from = vi.spyOn(Buffer, 'from')
    const allocUnsafe = vi.spyOn(Buffer, 'allocUnsafe')
    const sent = agentJournalItemForWire({
      itemId: 'command',
      revision: 1,
      body,
      sequence: 1,
      observedAt: 1
    }).item
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

    expect(sent.shortened).toBe(true)
    expect(sent.body).toMatchObject({
      kind: 'tool-call',
      input: { command: 'cat large.log', cwd: '/workspace' },
      output: {
        head: 'x'.repeat(AGENT_SESSION_WIRE_PAYLOAD_HEAD_BYTES),
        byteLength: payload.length,
        truncated: true
      }
    })
    expect(encodedStringBytes).toBeLessThanOrEqual(AGENT_SESSION_WIRE_PAYLOAD_HEAD_BYTES)
    expect(largestAllocation).toBeLessThanOrEqual(AGENT_SESSION_WIRE_PAYLOAD_HEAD_BYTES)
  })

  it('journals running tool output as a preview and the closing revision whole', () => {
    const output = journalPayload('x'.repeat(64 * 1024))
    const preview = { ...output, head: 'x'.repeat(16 * 1024), truncated: true }
    const call = (state: AgentJournalToolCallState): AgentJournalItemBody => ({
      kind: 'tool-call',
      name: 'shell',
      callId: 'call',
      input: null,
      state,
      output
    })
    const journal = createJournalReducerState('session-1', 'epoch-1')
    const itemRow = (body: AgentJournalItemBody) =>
      buildJournalItemRow({
        state: journal,
        itemId: 'call',
        body,
        seq: 1,
        fence: 1,
        ts: 1,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      }).body
    const batchRow = (body: AgentJournalItemBody) =>
      journalLifecycleBatchRowBuilder(
        () => journal,
        'settle',
        [{ kind: 'item', itemId: 'call', body, turnScope: AGENT_JOURNAL_THREAD_SCOPE }],
        { fence: 1 }
      )(1, 1).mutations[0]

    expect(itemRow(call('running'))).toMatchObject({ output: preview })
    expect(batchRow(call('running'))).toMatchObject({ body: { output: preview } })
    expect(itemRow(call('completed'))).toMatchObject({ output })
    expect(batchRow(call('failed'))).toMatchObject({ body: { output } })
  })

  it('preserves UTF-8 clipping, replacement characters, metadata and exotic byte limits', () => {
    const cap = AGENT_SESSION_WIRE_PAYLOAD_HEAD_BYTES
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
