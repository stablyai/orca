import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { boundWorkerTranscriptMessages } from '../../runtime/orchestration/worker-transcript-payload'
import {
  dispatchPayloadScope,
  readLocalDispatchPayload
} from '../../runtime/rpc/methods/orchestration/worker/worker-payload-read'
import { getDefaultJournalPayloadRetention, journalPayloadDigest } from './journal-payload-retention-default'
import {
  clearJournalPayloadRetention,
  ensureJournalPayloadRetention
} from './journal-payload-retention-install'
import { PAYLOAD_STORE_DIR_NAME } from './journal-payload-store'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-payload-retention-install-'))
  clearJournalPayloadRetention()
})

afterEach(async () => {
  clearJournalPayloadRetention()
  await rm(root, { recursive: true, force: true })
})

describe('ensureJournalPayloadRetention', () => {
  it('installs once per state root and keeps the store on a repeat call', () => {
    const first = ensureJournalPayloadRetention({ stateDirectory: root })
    const second = ensureJournalPayloadRetention({ stateDirectory: root })
    expect(second).toBe(first)
    expect(getDefaultJournalPayloadRetention()).toBe(first)
    expect(first).toMatchObject({ directory: join(root, PAYLOAD_STORE_DIR_NAME) })
  })

  it('serves a terminal-only worker read without any structured session host', () => {
    // The production fault: retention used to be installed by the structured
    // host alone, so a fresh app running only terminal-mode workers clipped
    // with null retention and could never hand the remainder back.
    ensureJournalPayloadRetention({ stateDirectory: root })
    const dispatchId = 'ctx_terminal_only'
    const output = `${'x'.repeat(40 * 1024)}\nCONSTRAINT-C past the clip`
    const bounded = boundWorkerTranscriptMessages(
      [
        {
          id: 'm1',
          role: 'assistant',
          timestamp: null,
          source: 'transcript',
          blocks: [{ type: 'tool-result', output }]
        }
      ],
      undefined,
      { payloadScope: dispatchPayloadScope(dispatchId) }
    )
    const block = bounded.messages[0]?.blocks[0]
    if (block?.type !== 'tool-result' || !block.clipped) {
      throw new Error('expected a clipped tool result')
    }
    expect(block.clipped).toEqual({
      digest: journalPayloadDigest(output),
      byteLength: Buffer.byteLength(output, 'utf8'),
      retrievable: true
    })
    const range = readLocalDispatchPayload({ dispatchId, digest: block.clipped.digest })
    expect(range.complete).toBe(true)
    expect(range.chunk).toBe(output)
    expect(() =>
      readLocalDispatchPayload({ dispatchId: 'ctx_other', digest: block.clipped!.digest })
    ).toThrow(/not referenced/)
  })

  it('reports nothing retrievable while no retention is installed', () => {
    const bounded = boundWorkerTranscriptMessages(
      [
        {
          id: 'm1',
          role: 'assistant',
          timestamp: null,
          source: 'transcript',
          blocks: [{ type: 'tool-result', output: 'y'.repeat(40 * 1024) }]
        }
      ],
      undefined,
      { payloadScope: dispatchPayloadScope('ctx_none') }
    )
    const block = bounded.messages[0]?.blocks[0]
    expect(block?.type === 'tool-result' ? block.clipped?.retrievable : null).toBe(false)
  })
})
