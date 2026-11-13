import { afterEach, expect, it, vi } from 'vitest'
import crypto from 'node:crypto'
import { decodeClaudeTranscriptLine } from './transcript-decoding/transcript-line-decoders-claude'
import { decodeClaudeTurnLifecycle } from './transcript-decoding/transcript-turn-lifecycle'
import { sanitizeNativeChatRpcMessage } from '../runtime/rpc/methods/native-chat/native-chat-rpc-block-sanitize'
import * as glue from '../../shared/native-chat/transcript/native-chat-pending-glue'
import * as imageText from '../../shared/native-chat/transcript/native-chat-image-transcript-markers'
import * as scanner from '../ai-vault/parsing/session-json-object'
import { opencodeMessages } from './transcript-history/opencode/transcript-opencode-part-blocks'
import { boundWorkerTranscriptMessages } from '../runtime/orchestration/workers/transcripts/worker-transcript-payload'
import { transcriptInputContent } from './transcript-input-content'
import { nativeChatRpcAppendBatches } from '../runtime/rpc/methods/native-chat/native-chat-rpc-page-bounds'
import { reconcileNativeChatPendingSends } from '../../shared/native-chat/transcript/native-chat-pending-reconciliation'
import type { NativeChatMessage } from '../../shared/native-chat/native-chat-types'
import {
  prunePendingSends,
  visibleNativeChatPendingSends,
  type NativeChatPendingSend
} from '../../shared/native-chat/transcript/native-chat-pending-sends'

afterEach(() => vi.restoreAllMocks())

function user(text: string, id: string): NativeChatMessage {
  return {
    id,
    role: 'user',
    timestamp: null,
    source: 'transcript',
    blocks: [{ type: 'text', text }],
    inputContent: transcriptInputContent('opencode', text)
  }
}

it.each([10, 100])(
  'parses each of %i source parts once and retains constant-size text evidence',
  (size) => {
    const parse = vi.spyOn(scanner, 'parseJsonObject')
    const parts = Array.from({ length: size }, () => ({
      message_id: 'user',
      time_updated: 0,
      data: JSON.stringify({ type: 'text', text: 'x'.repeat(1000) })
    }))
    const [message] = opencodeMessages(
      { id: 'user', role: 'user', timestamp: null },
      parts,
      [],
      true
    )
    expect(parse).toHaveBeenCalledTimes(size)
    // One provider name, a 64-character digest and an empty path list fit within 128 bytes.
    expect(Buffer.byteLength(JSON.stringify(message.inputContent))).toBeLessThanOrEqual(128)
  }
)

it.each([10, 100])('measures each of %i appended rows once before transport', (size) => {
  let serializations = 0
  const rows = Array.from({ length: size }, (_, index) => {
    const row = user('body', `user-${index}`)
    return {
      ...row,
      toJSON: () => {
        serializations++
        return row
      }
    }
  })
  expect(nativeChatRpcAppendBatches(rows).flat()).toHaveLength(size)
  expect(serializations).toBe(size)
})

it.each([100, 1000])(
  'derives only the appended source key with %i old rows and eight pending sends',
  (size) => {
    const context = {
      owner: 'read',
      sessionId: 'session',
      targetPtyId: 'pty',
      runtimeEnvironmentId: null
    }
    const retainedUser = (text: string, id: string) =>
      decodeClaudeTranscriptLine(
        JSON.stringify({
          type: 'user',
          uuid: id,
          message: { role: 'user', content: [{ type: 'text', text }] }
        }),
        id
      )!
    const pending: NativeChatPendingSend[] = Array.from({ length: 8 }, (_, index) => ({
      id: `send-${index}`,
      sourceAgent: 'claude',
      text: `arriving-${index}`,
      sentAt: 1,
      sourceContext: context,
      promptBinding: {
        runtimeId: 'host',
        ptyId: 'pty',
        generation: 1,
        processIncarnation: 'pty:1',
        terminalHandle: 'terminal',
        targetPtyId: 'pty',
        runtimeEnvironmentId: null
      },
      promptSubmission: {
        observation: {
          origin: 'hook',
          authorityId: 'host',
          incarnation: 1,
          revision: 2,
          observedAt: 10
        },
        sessionId: 'session',
        textDigest: crypto.createHash('sha256').update(`arriving-${index}`).digest('hex'),
        connectionId: null,
        process: { pid: 42, platform: 'linux', startTime: '1' }
      }
    }))
    const history = Array.from({ length: size }, (_, index) =>
      retainedUser(`old-${index}`, `old-${index}`)
    )
    expect(prunePendingSends(pending, history, 'session', context)).toBe(pending)
    const messages = [
      ...history,
      retainedUser('arriving-0', 'new'),
      { ...user('answer', 'answer'), role: 'assistant' as const, inputContent: undefined }
    ]
    const serialize = vi.spyOn(JSON, 'stringify')
    const remaining = prunePendingSends(pending, messages, 'session', context)
    const visible = visibleNativeChatPendingSends(pending, messages, 'session', context)
    expect(serialize).toHaveBeenCalledTimes(1)
    expect(
      reconcileNativeChatPendingSends(pending, messages, 'session', context).witnesses.map(
        (witness) => witness.proof
      )
    ).toEqual(['source'])
    expect(remaining.map((entry) => entry.id)).toEqual([
      'send-1',
      'send-2',
      'send-3',
      'send-4',
      'send-5',
      'send-6',
      'send-7'
    ])
    expect(visible).toEqual(remaining)
  }
)

it.each([10, 100])('hashes only evidence used by desktop for %i decoded user rows', (size) => {
  const hash = vi.spyOn(crypto, 'createHash')
  const messages = Array.from({ length: size }, (_, index) => {
    const line = JSON.stringify({
      type: 'user',
      uuid: `user-${index}`,
      message: { role: 'user', content: [{ type: 'text', text: 'exact input' }] }
    })
    expect(decodeClaudeTurnLifecycle(line, 'fallback')?.state).toBe('working')
    return decodeClaudeTranscriptLine(line, 'fallback')!
  })
  expect(hash).not.toHaveBeenCalled()
  JSON.stringify(messages.map((message) => sanitizeNativeChatRpcMessage(message, 'mobile')))
  expect(hash).not.toHaveBeenCalled()
  const desktop = messages.map((message) => sanitizeNativeChatRpcMessage(message, 'runtime'))
  const serialized = JSON.stringify(desktop)
  const cloned = structuredClone(desktop)
  expect(JSON.stringify(cloned)).toBe(serialized)
  expect(hash).toHaveBeenCalledTimes(size)
  expect(cloned[0].inputContent?.textDigest).toBe(
    '5d199cb821847bdb649a17bc8d105b453a6538f0af5ce520959964e520fdcfe5'
  )
})

it.each([5, 50])('does not evaluate receipt evidence in %i worker transcript rows', (size) => {
  const messages = Array.from({ length: size }, (_, index) => user('exact input', `u${index}`))
  const hash = vi.spyOn(crypto, 'createHash')
  const result = boundWorkerTranscriptMessages(messages)
  JSON.stringify(result)
  structuredClone(result)
  expect(result.messages).toHaveLength(size)
  expect(result.messages.every((message) => !message.inputContent)).toBe(true)
  expect(hash).not.toHaveBeenCalled()
  // Native desktop still materializes one digest per complete source unit, cached through cloning.
  const native = messages.map((message) => sanitizeNativeChatRpcMessage(message, 'runtime'))
  JSON.stringify(native)
  structuredClone(native)
  expect(hash).toHaveBeenCalledTimes(size)
})

it.each([
  { size: 1000, image: false },
  { size: 10000, image: false },
  { size: 1000, image: true },
  { size: 10000, image: true }
])(
  'gates legacy proof work before live boundaries: $size rows, image $image',
  ({ size, image }) => {
    const history = Array.from({ length: size }, (_, index) => user(`old-${index}`, `old-${index}`))
    const boundary = {
      ...user('boundary', 'boundary'),
      role: 'assistant' as const,
      inputContent: undefined
    }
    const appended: NativeChatMessage = image
      ? {
          ...user('', 'append'),
          inputContent: undefined,
          blocks: [{ type: 'image-ref', url: 'data:image/png;base64,iVBORw0K' }]
        }
      : user('unrelated', 'append')
    for (const count of [1, 8]) {
      const pending: NativeChatPendingSend[] = Array.from({ length: count }, (_, index) => ({
        id: `p${index}`,
        text: image ? '' : `piece-${index}`,
        imagePaths: image ? [`/tmp/p${index}.png`] : undefined,
        sentAt: 1,
        afterMessageId: 'boundary'
      }))
      const normalize = vi.spyOn(imageText, 'normalizedNativeChatUserMessageText')
      const prepare = vi.spyOn(imageText, 'normalizeNativeChatUserText')
      const match = vi.spyOn(glue, 'selectPendingIndicesRepresentedByUserRows')
      const messages = [...history, boundary, appended]
      const kept = prunePendingSends(pending, messages)
      if (image) {
        expect(kept.map((entry) => entry.id)).toEqual(
          count === 1 ? ['p0'] : ['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']
        )
        expect(kept[0].sourceReceipt).toEqual({ sessionId: '', id: 'append' })
      } else {
        expect(kept).toBe(pending)
      }
      // Only the appended row reaches exact and optional pathless shape proof; glue reads it once.
      expect(normalize.mock.calls.length).toBeLessThanOrEqual(
        image ? 2 * count + 1 : count + (count === 1 ? 0 : 1)
      )
      // Keys/pieces/eligibility cost at most four per send, image row checks two, plus the suffix.
      expect(prepare.mock.calls.length).toBeLessThanOrEqual((image ? 6 : 4) * count + 2)
      expect(match.mock.calls.length).toBeLessThanOrEqual(count === 1 ? 0 : 255)
      normalize.mockRestore()
      prepare.mockRestore()
      match.mockRestore()
    }
  }
)

it.each([
  [8, 'continue', false],
  [80, 'continue', false],
  [8, 'continue continue', false],
  [80, 'continue continue', false],
  [8, 'continue continue', true],
  [80, 'continue continue', true]
] as const)(
  'bounds allocation work for eight identical legacy sends across %i eligible rows of %s',
  (rows, text, image) => {
    const count = 8
    const pending: NativeChatPendingSend[] = Array.from({ length: count }, (_, index) => ({
      id: `same-${index}`,
      text: image && index < 2 ? 'continue continue' : 'continue',
      imagePaths: image && index === 0 ? ['/tmp/i.png'] : undefined,
      sentAt: 1
    }))
    const messages = [
      ...Array.from({ length: rows }, (_, index) => user(text, `same-row-${index}`)),
      { ...user('', 'reply'), role: 'assistant' as const }
    ]
    if (image) {
      const group = [pending[0], pending[2], pending[3]]
      expect(visibleNativeChatPendingSends(group, [messages[0]])).toEqual([])
    }
    const BaseMap = globalThis.Map
    let writes = 0
    let lookups = 0
    class CountingMap<K, V> extends BaseMap<K, V> {
      override get(key: K): V | undefined {
        lookups++
        return super.get(key)
      }
      override set(key: K, value: V): this {
        writes++
        return super.set(key, value)
      }
    }
    vi.stubGlobal('Map', CountingMap)
    try {
      const startedAt = performance.now()
      const remaining = prunePendingSends(pending, messages)
      const elapsedMs = performance.now() - startedAt
      const allocationLookups = lookups
      expect(remaining).toEqual([])
      // Eight legal row alternatives per signature; each state assigns, requires or omits each send.
      const states = 3 ** count
      const witnessesPerRow = (image ? 2 : 1) * (2 ** count - 1) + count
      // This corpus has two exact-rank patterns and one advance pattern; each signature keeps at most P rows.
      const exactPatterns = image ? 2 : 1
      const maxAllocationWrites = count * exactPatterns * states * (witnessesPerRow + 1)
      expect(writes).toBeLessThanOrEqual(maxAllocationWrites + rows + 2 ** count)
      // Every candidate allocates before its next-state lookup, including candidates never written.
      expect(allocationLookups).toBeLessThanOrEqual(maxAllocationWrites + rows * count + 2 ** count)
      console.info('legacy allocation count', {
        rows,
        text,
        pending: count,
        mapWrites: writes,
        candidateAllocationUpperBound: allocationLookups,
        elapsedMs
      })
    } finally {
      vi.stubGlobal('Map', BaseMap)
    }
  }
)
