// The remainder of a bounded payload is retained, not dropped.

import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  JOURNAL_OVERFLOW_NOT_RETAINED,
  journalOverflowDirectory,
  journalOverflowSink,
  readJournalOverflow
} from './journal-overflow-store'
import { boundInlineText, boundPayload, digestPayload } from './journal-payload-bounds'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-overflow-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('bounding a payload larger than the row budget', () => {
  const limits = (dir: string, quota?: number) => ({
    inlineHeadBytes: 16,
    overflow: journalOverflowSink(dir, quota)
  })

  it('retains every byte the clip drops, readable back by the row digest', () => {
    const payload = `${'x'.repeat(4_096)}λ tail`
    const bounded = boundPayload(payload, limits(root))

    expect(bounded.truncated).toBe(true)
    expect(bounded.head).toHaveLength(16)
    expect(bounded.spilled).toBe(true)
    // The whole payload, not the clipped head: this is the P0.
    expect(readJournalOverflow(root, bounded.digest)).toBe(payload)
    expect(bounded.digest).toBe(digestPayload(payload))
  })

  it('retains the text behind an inline truncation marker too', () => {
    const payload = 'assistant output '.repeat(400)
    const { text, bounded } = boundInlineText(payload, limits(root))

    expect(text).toContain('[Orca: output truncated')
    expect(readJournalOverflow(root, bounded.digest)).toBe(payload)
  })

  it('leaves a payload that fits inline with nothing retained', () => {
    const bounded = boundPayload('short', limits(root))

    expect(bounded).toMatchObject({ truncated: false, head: 'short' })
    expect(bounded.spilled).toBeUndefined()
    expect(readJournalOverflow(root, bounded.digest)).toBeNull()
  })

  it('retains identical payloads once, so item revisions do not accumulate copies', async () => {
    const payload = 'y'.repeat(4_096)
    boundPayload(payload, limits(root))
    boundPayload(payload, limits(root))
    boundPayload(payload, limits(root))

    expect(await readdir(journalOverflowDirectory(root))).toHaveLength(1)
  })

  it('marks the row unspilled rather than failing when retention cannot happen', async () => {
    // A file where the store needs its directory: every write below fails.
    await writeFile(journalOverflowDirectory(root), 'not a directory')
    const payload = 'z'.repeat(4_096)
    const bounded = boundPayload(payload, limits(root))

    expect(bounded).toMatchObject({ truncated: true, byteLength: 4_096 })
    expect(bounded.spilled).toBeUndefined()
    expect(readJournalOverflow(root, bounded.digest)).toBeNull()
  })

  it('sheds the oldest retained payloads to stay inside the quota', async () => {
    const quota = 6_000
    const first = boundPayload('a'.repeat(4_000), limits(root, quota))
    const second = boundPayload('b'.repeat(4_000), limits(root, quota))

    expect(second.spilled).toBe(true)
    expect(readJournalOverflow(root, second.digest)).toBe('b'.repeat(4_000))
    // Two 4 KB payloads do not fit in a 6 KB budget; the older one goes.
    expect(readJournalOverflow(root, first.digest)).toBeNull()
    expect(await readdir(journalOverflowDirectory(root))).toHaveLength(1)
  })

  it('refuses a single payload larger than the whole quota without evicting for it', () => {
    const quota = 2_000
    const kept = boundPayload('a'.repeat(1_000), limits(root, quota))
    const oversized = boundPayload('b'.repeat(9_000), limits(root, quota))

    expect(oversized).toMatchObject({ truncated: true, byteLength: 9_000 })
    expect(oversized.spilled).toBeUndefined()
    expect(readJournalOverflow(root, kept.digest)).toBe('a'.repeat(1_000))
  })
})

describe('a bound that deliberately retains nothing', () => {
  it('still reports the clip, its length and its digest', () => {
    const bounded = boundPayload('k'.repeat(4_096), {
      inlineHeadBytes: 16,
      overflow: JOURNAL_OVERFLOW_NOT_RETAINED
    })

    expect(bounded).toMatchObject({ truncated: true, byteLength: 4_096 })
    expect(bounded.spilled).toBeUndefined()
  })
})
