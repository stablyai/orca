import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../../../shared/native-chat-types'
import { boundWorkerTranscriptMessages } from '../../../../orchestration/worker-transcript-payload'
import {
  JournalPayloadStore,
  setDefaultJournalPayloadRetention
} from '../../../../../native-chat/agent-session-journal/journal-payload-store'
import {
  dispatchPayloadScope,
  parseRemotePayloadReply,
  readLocalDispatchPayload
} from './worker-payload-read'

const CAPABILITY = `dcap_${'Q'.repeat(40)}`
let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-worker-payload-'))
  setDefaultJournalPayloadRetention(new JournalPayloadStore({ directory }))
})
afterEach(async () => {
  setDefaultJournalPayloadRetention(null)
  await rm(directory, { recursive: true, force: true })
})

function transcriptMessage(text: string): NativeChatMessage {
  return { id: 'm1', role: 'assistant', timestamp: null, source: 'transcript',
    blocks: [{ type: 'text', text }] }
}

function longText(): string {
  return `head ${'x'.repeat(2_000)} middle token ${CAPABILITY} tail CONSTRAINT-C ääkköset 🧩`
}

describe('worker readback retention and owner-checked payload read', () => {
  it('clips the block, retains the redacted original, and serves it to the same Dispatch', () => {
    const bounded = boundWorkerTranscriptMessages([transcriptMessage(longText())], undefined,
      { payloadScope: dispatchPayloadScope('ctx_owner') })
    const block = bounded.messages[0]!.blocks[0]!
    expect(block.type).toBe('text')
    if (block.type !== 'text') {
      throw new Error('unexpected block')
    }
    expect(block.text).toContain('… (truncated)')
    expect(block.text).toMatch(/\[full text \d+ bytes, digest [0-9a-f]{64}\]$/)
    expect(block.clipped).toMatchObject({ retrievable: true })
    expect(bounded.warnings).toContain('Oversized transcript text was clipped.')
    expect(JSON.stringify(bounded)).not.toContain(CAPABILITY)

    const range = readLocalDispatchPayload({ dispatchId: 'ctx_owner', digest: block.clipped!.digest })
    expect(range.complete).toBe(true)
    expect(range.chunk).toContain('CONSTRAINT-C')
    expect(range.chunk).not.toContain(CAPABILITY)
    expect(range.chunk).toContain('[dispatch capability redacted]')
    expect(range.byteLength).toBe(block.clipped!.byteLength)
  })

  it('refuses another Dispatch, an unknown digest, and a tampered file', async () => {
    const bounded = boundWorkerTranscriptMessages([transcriptMessage(longText())], undefined,
      { payloadScope: dispatchPayloadScope('ctx_owner') })
    const block = bounded.messages[0]!.blocks[0]!
    if (block.type !== 'text') {
      throw new Error('unexpected block')
    }
    const digest = block.clipped!.digest
    expect(() => readLocalDispatchPayload({ dispatchId: 'ctx_other', digest }))
      .toThrow(expect.objectContaining({ code: 'payload_not_referenced' }))
    expect(() => readLocalDispatchPayload({ dispatchId: 'ctx_owner', digest: 'f'.repeat(64) }))
      .toThrow(expect.objectContaining({ code: 'payload_not_referenced' }))
    await writeFile(join(directory, `${digest}.payload`), 'tampered')
    expect(() => readLocalDispatchPayload({ dispatchId: 'ctx_owner', digest }))
      .toThrow(expect.objectContaining({ code: 'payload_integrity_failed' }))
  })

  it('keeps the legacy lossy clip when no retention is installed', () => {
    setDefaultJournalPayloadRetention(null)
    const bounded = boundWorkerTranscriptMessages([transcriptMessage(longText())], undefined,
      { payloadScope: dispatchPayloadScope('ctx_owner') })
    const block = bounded.messages[0]!.blocks[0]!
    if (block.type !== 'text') {
      throw new Error('unexpected block')
    }
    expect(block.text.endsWith('… (truncated)')).toBe(true)
    expect(block.clipped).toMatchObject({ retrievable: false })
    expect(() => readLocalDispatchPayload({ dispatchId: 'ctx_owner', digest: block.clipped!.digest }))
      .toThrow(expect.objectContaining({ code: 'payload_not_retained' }))
  })
})

describe('a federated payload reply is bound to the request that asked for it', () => {
  const DIGEST = 'a'.repeat(64)
  const OTHER = 'b'.repeat(64)
  const reply = (payload: Record<string, unknown>): unknown => ({ runtimeEpoch: 'epoch-1', payload })
  const good = {
    digest: DIGEST, chunk: 'hello', byteLength: 11, chunkOffset: 0, chunkByteLength: 5,
    complete: false
  }

  it('accepts a reply that answers the requested digest and describes its own bytes', () => {
    const parsed = parseRemotePayloadReply(reply(good), { digest: DIGEST, offset: 0 })
    expect(parsed.runtimeEpoch).toBe('epoch-1')
    expect(parsed.payload).toMatchObject({ digest: DIGEST, chunkByteLength: 5, complete: false })
    // The last page of the same payload closes it out.
    expect(
      parseRemotePayloadReply(
        reply({ ...good, chunk: ' world', chunkOffset: 5, chunkByteLength: 6, complete: true }),
        { digest: DIGEST, offset: 5 }
      ).payload.complete
    ).toBe(true)
  })

  it.each([
    ['a different digest', { ...good, digest: OTHER }, 0],
    ['a chunk length that contradicts the bytes', { ...good, chunkByteLength: 4 }, 0],
    ['an offset past the one requested', { ...good, chunkOffset: 6 }, 0],
    ['a fractional byte length', { ...good, byteLength: 11.5 }, 0],
    ['a negative offset', { ...good, chunkOffset: -1 }, 0],
    ['a chunk that runs past the payload', { ...good, byteLength: 3 }, 0],
    ['completion claimed before the end', { ...good, complete: true }, 0],
    ['completion withheld at the end', { ...good, byteLength: 5, complete: false }, 0]
  ])('refuses %s', (_case, payload, offset) => {
    expect(() => parseRemotePayloadReply(reply(payload), { digest: DIGEST, offset })).toThrow(
      expect.objectContaining({ code: 'payload_integrity_failed' })
    )
  })

  it('refuses a reply that is not a payload envelope at all', () => {
    for (const value of [null, 'text', {}, { runtimeEpoch: 'e', payload: null }]) {
      expect(() => parseRemotePayloadReply(value, { digest: DIGEST })).toThrow(
        expect.objectContaining({ code: 'payload_integrity_failed' })
      )
    }
  })
})
