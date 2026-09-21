import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  boundInlineText,
  boundPayload,
  boundToolInput,
  DEFAULT_JOURNAL_PAYLOAD_LIMITS,
  journalTruncationMarker
} from './journal-payload-bounds'
import {
  JournalPayloadIntegrityError,
  JournalPayloadStore,
  retrieveJournalPayload,
  setDefaultJournalPayloadRetention
} from './journal-payload-store'

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

// The reproduction: a 35,737-byte response was shown as a 16 KiB head. Build a
// deterministic payload with a constraint that sits after the boundary.
function counterexample(): string {
  const lines: string[] = ['# CONSTRAINT-A: reply must include ALPHA']
  while (Buffer.byteLength(lines.join('\n'), 'utf8') < 30_000) {
    lines.push(`filler ${lines.length} ääkköset 🧩 ${'x'.repeat(40)}`)
  }
  lines.push('# CONSTRAINT-C: reply must include ZETA (after the 16 KiB head)')
  lines.push('END OF ARTIFACT')
  return lines.join('\n')
}

describe('journal payload retention', () => {
  let directory: string
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'journal-payload-store-'))
  })
  afterEach(async () => {
    setDefaultJournalPayloadRetention(null)
    await rm(directory, { recursive: true, force: true })
  })

  it('discards the remainder and says so when no retention is installed', () => {
    const payload = counterexample()
    const bounded = boundPayload(payload, DEFAULT_JOURNAL_PAYLOAD_LIMITS, null)
    expect(bounded.truncated).toBe(true)
    expect(bounded.retrievable).toBe(false)
    expect(Buffer.byteLength(bounded.head, 'utf8')).toBeLessThanOrEqual(16 * 1024)
    expect(bounded.head).not.toContain('CONSTRAINT-C')
    expect(retrieveJournalPayload(bounded.digest)).toBeNull()
  })

  it('retains the complete original under its digest and retrieves it exactly', async () => {
    const store = new JournalPayloadStore({ directory })
    const payload = counterexample()
    const bounded = boundPayload(payload, DEFAULT_JOURNAL_PAYLOAD_LIMITS, store)
    expect(bounded.truncated).toBe(true)
    expect(bounded.retrievable).toBe(true)
    expect(bounded.byteLength).toBe(Buffer.byteLength(payload, 'utf8'))
    expect(bounded.digest).toBe(sha256(payload))
    const retrieved = store.retrieve(bounded.digest)
    expect(retrieved).toBe(payload)
    expect(retrieved).toContain('CONSTRAINT-C')
    expect(retrieved?.endsWith('END OF ARTIFACT')).toBe(true)
    expect(await readdir(directory)).toEqual([`${bounded.digest}.payload`])
  })

  it('serves the installed default retention to inline text and tool input bounds', () => {
    setDefaultJournalPayloadRetention(new JournalPayloadStore({ directory }))
    const payload = counterexample()
    const inline = boundInlineText(payload, DEFAULT_JOURNAL_PAYLOAD_LIMITS)
    expect(inline.text.endsWith(journalTruncationMarker(inline.bounded.byteLength, inline.bounded.digest))).toBe(true)
    expect(inline.bounded.retrievable).toBe(true)
    expect(retrieveJournalPayload(inline.bounded.digest)).toBe(payload)
    const tool = boundToolInput({ big: payload }, DEFAULT_JOURNAL_PAYLOAD_LIMITS)
    if (typeof tool !== 'object' || tool === null) {
      throw new Error('expected a bounded record')
    }
    const bounded: Record<string, unknown> = Object.fromEntries(Object.entries(tool))
    expect(bounded.truncated).toBe(true)
    expect(bounded.retrievable).toBe(true)
    expect(retrieveJournalPayload(String(bounded.digest))).toBe(JSON.stringify({ big: payload }))
  })

  it('keeps small payloads inline and untouched', () => {
    const store = new JournalPayloadStore({ directory })
    const bounded = boundPayload('short', DEFAULT_JOURNAL_PAYLOAD_LIMITS, store)
    expect(bounded).toEqual({ head: 'short', byteLength: 5, digest: sha256('short'), truncated: false })
  })

  it('refuses a retained file whose bytes no longer match the digest', async () => {
    const store = new JournalPayloadStore({ directory })
    const payload = counterexample()
    const bounded = boundPayload(payload, DEFAULT_JOURNAL_PAYLOAD_LIMITS, store)
    await writeFile(join(directory, `${bounded.digest}.payload`), 'tampered', { mode: 0o600 })
    expect(() => store.retrieve(bounded.digest)).toThrow(JournalPayloadIntegrityError)
  })

  it('returns null for an unknown digest and rejects malformed digests', () => {
    const store = new JournalPayloadStore({ directory })
    expect(store.retrieve(sha256('never stored'))).toBeNull()
    expect(() => store.retrieve('not-a-digest')).toThrow(/Invalid payload digest/)
  })

  it('refuses retention above the configured bound and reports it on the row', () => {
    const store = new JournalPayloadStore({ directory, maxRetainedBytes: 1_000 })
    const bounded = boundPayload(counterexample(), DEFAULT_JOURNAL_PAYLOAD_LIMITS, store)
    expect(bounded.truncated).toBe(true)
    expect(bounded.retrievable).toBe(false)
    expect(store.retrieve(bounded.digest)).toBeNull()
  })

  it('is idempotent for repeated retention of the same content', () => {
    const store = new JournalPayloadStore({ directory })
    const payload = counterexample()
    const first = boundPayload(payload, DEFAULT_JOURNAL_PAYLOAD_LIMITS, store)
    const second = boundPayload(payload, DEFAULT_JOURNAL_PAYLOAD_LIMITS, store)
    expect(second.retrievable).toBe(true)
    expect(second.digest).toBe(first.digest)
  })
})

describe('journal payload retention: scopes, ranges and pruning', () => {
  let directory: string
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'journal-payload-store-ext-'))
  })
  afterEach(async () => {
    setDefaultJournalPayloadRetention(null)
    await rm(directory, { recursive: true, force: true })
  })

  it('records the referencing scope and refuses a scope it never saw', () => {
    const store = new JournalPayloadStore({ directory })
    const payload = counterexample()
    const digest = sha256(payload)
    expect(store.retain(digest, payload, 'dispatch:ctx_owner')).toBe(true)
    expect(store.isReferencedBy(digest, 'dispatch:ctx_owner')).toBe(true)
    expect(store.isReferencedBy(digest, 'dispatch:ctx_other')).toBe(false)
    expect(store.isReferencedBy(digest, 'not a scope')).toBe(false)
    // A second producer of the same content adds its scope without duplicating bytes.
    expect(store.retain(digest, payload, 'session:s2')).toBe(true)
    expect(store.isReferencedBy(digest, 'session:s2')).toBe(true)
  })

  it('serves exact byte ranges that never split a multi-byte character and end at EOF', () => {
    const store = new JournalPayloadStore({ directory })
    const payload = counterexample()
    const digest = sha256(payload)
    store.retain(digest, payload)
    const total = Buffer.byteLength(payload, 'utf8')
    let offset = 0
    const parts: string[] = []
    let complete = false
    while (!complete) {
      const range = store.retrieveRange(digest, offset, 7_001)
      expect(range).not.toBeNull()
      expect(range!.byteLength).toBe(total)
      expect(range!.chunkOffset).toBe(offset)
      expect(Buffer.byteLength(range!.chunk, 'utf8')).toBe(range!.chunkByteLength)
      parts.push(range!.chunk)
      offset += range!.chunkByteLength
      complete = range!.complete
    }
    expect(parts.join('')).toBe(payload)
    expect(offset).toBe(total)
    expect(store.retrieveRange(digest, total + 10, 5)?.complete).toBe(true)
    expect(() => store.retrieveRange(digest, -1, 5)).toThrow(/non-negative/)
    expect(store.retrieveRange(sha256('nothing'), 0, 5)).toBeNull()
  })

  it('refuses any range from a tampered file', async () => {
    const store = new JournalPayloadStore({ directory })
    const payload = counterexample()
    const digest = sha256(payload)
    store.retain(digest, payload)
    await writeFile(join(directory, `${digest}.payload`), payload.replace('ALPHA', 'OMEGA'), { mode: 0o600 })
    expect(() => store.retrieveRange(digest, 0, 16)).toThrow(JournalPayloadIntegrityError)
  })

  it('prunes by age and by total bytes, oldest first, together with scope records', async () => {
    const store = new JournalPayloadStore({ directory })
    const older = `${counterexample()}\nOLDER`
    const newer = `${counterexample()}\nNEWER`
    const olderDigest = sha256(older)
    const newerDigest = sha256(newer)
    store.retain(olderDigest, older, 'dispatch:a')
    store.retain(newerDigest, newer, 'dispatch:b')
    const now = Date.now()
    const { utimes } = await import('node:fs/promises')
    await utimes(join(directory, `${olderDigest}.payload`), (now - 100_000) / 1000, (now - 100_000) / 1000)
    const byAge = store.prune({ maxAgeMs: 50_000, maxTotalBytes: Number.MAX_SAFE_INTEGER, now })
    expect(byAge).toMatchObject({ scanned: 2, removed: 1 })
    expect(store.retrieve(olderDigest)).toBeNull()
    expect(store.isReferencedBy(olderDigest, 'dispatch:a')).toBe(false)
    expect(store.retrieve(newerDigest)).toBe(newer)
    const byCap = store.prune({ maxAgeMs: Number.MAX_SAFE_INTEGER, maxTotalBytes: 10, now })
    expect(byCap.removed).toBe(1)
    expect(store.retrieve(newerDigest)).toBeNull()
    expect((await readdir(directory)).length).toBe(0)
  })
})

describe('journal payload retention: identity of an existing file', () => {
  let directory: string
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'journal-payload-store-identity-'))
  })
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('re-hashes an existing file on retain and replaces an equal-size impostor', async () => {
    const store = new JournalPayloadStore({ directory })
    const payload = counterexample()
    const digest = sha256(payload)
    const impostor = payload.replace('ALPHA', 'OMEGA') // same byte length, different bytes
    await writeFile(join(directory, `${digest}.payload`), impostor, { mode: 0o600 })
    expect(store.retain(digest, payload)).toBe(true)
    expect(store.retrieve(digest)).toBe(payload)
  })

  it('never reports retention for a file that cannot be written and leaves no temporary behind', async () => {
    const store = new JournalPayloadStore({ directory })
    const payload = counterexample()
    const digest = sha256(payload)
    // Occupy the target path with a directory so the rename must fail.
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(directory, `${digest}.payload`))
    expect(store.retain(digest, payload)).toBe(false)
    expect((await readdir(directory)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('drops stale temporaries during a prune', async () => {
    const store = new JournalPayloadStore({ directory })
    await writeFile(join(directory, `${sha256('x')}.payload.1.2.abc.tmp`), 'partial')
    store.prune({ maxAgeMs: Number.MAX_SAFE_INTEGER, maxTotalBytes: Number.MAX_SAFE_INTEGER })
    expect(await readdir(directory)).toEqual([])
  })
})
