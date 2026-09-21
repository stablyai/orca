// Content-addressed retention for bounded journal and transcript payloads.
//
// A bounded payload keeps only a head on the row (see journal-payload-bounds).
// Discarding the remainder is safe for replay cost but unsafe for meaning: a
// reader that only sees the head can be led to act on an incomplete
// instruction, constraint, or result. This store retains the complete original
// bytes keyed by the payload digest already carried on every bounded row, so
// the full content can be retrieved later and verified against that digest.
//
// Properties:
// - content-addressed: the file name is the sha256 of the original text;
//   retaining the same content twice is idempotent;
// - verified on read: a stored file whose bytes no longer hash to the digest
//   is refused rather than returned as if complete;
// - bounded: retention above `maxRetainedBytes` is refused explicitly and the
//   row stays `retrievable: false`, never silently mis-labelled;
// - scoped: a producer may record the scope (session or dispatch) that
//   references a digest; readers that cannot prove a reference through their
//   own data (transcripts have no journal) check that index instead;
// - private: directory 0700, files 0600;
// - pruned: files older than the retention age or beyond the total byte cap
//   are removed oldest-first, never on a live read path.

import { createHash } from 'node:crypto'
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import {
  alignUtf8End,
  alignUtf8Start,
  fileIdentity,
  hashDescriptor,
  type VerifiedFileIdentity
} from './journal-payload-file-bytes'

export type JournalPayloadRetention = {
  /** Retain the complete original text under its digest, optionally recording
   *  the scope that references it. Returns true only when the bytes are durably
   *  stored and re-hash to `digest`. */
  retain(digest: string, payload: string, scope?: string): boolean
  /** Return the exact original text for `digest`, or null when nothing is
   *  retained. Throws `JournalPayloadIntegrityError` on a digest mismatch. */
  retrieve(digest: string): string | null
  /** Return an exact byte range of the retained original after verifying the
   *  whole file against `digest`; null when nothing is retained. */
  retrieveRange(digest: string, offset: number, limit: number): JournalPayloadRange | null
  /** True when `scope` was recorded as referencing `digest`. */
  isReferencedBy(digest: string, scope: string): boolean
}

export type JournalPayloadRange = {
  digest: string
  byteLength: number
  chunk: string
  chunkOffset: number
  chunkByteLength: number
  complete: boolean
}

export class JournalPayloadIntegrityError extends Error {
  readonly digest: string
  readonly actualDigest: string
  /** Names both digests so a caller can tell a tampered file from a missing one. */
  constructor(digest: string, actualDigest: string) {
    super(`Retained payload for digest ${digest.slice(0, 12)} hashes to ${actualDigest.slice(0, 12)}; refusing to return mismatched content.`)
    this.name = 'JournalPayloadIntegrityError'
    this.digest = digest
    this.actualDigest = actualDigest
  }
}

const DIGEST_PATTERN = /^[0-9a-f]{64}$/
const SCOPE_PATTERN = /^[a-z]+:[A-Za-z0-9._:-]{1,200}$/
const PAYLOAD_SUFFIX = '.payload'
const SCOPES_SUFFIX = '.scopes'

export type JournalPayloadStoreOptions = {
  directory: string
  /** Largest original payload retained in full; larger payloads keep only the row head. */
  maxRetainedBytes?: number
}

export type JournalPayloadPruneOptions = {
  /** Files last modified earlier than this are removed. */
  maxAgeMs: number
  /** Total retained bytes kept; the oldest files beyond it are removed. */
  maxTotalBytes: number
  now?: number
}

export type JournalPayloadPruneReport = {
  scanned: number
  removed: number
  retainedBytes: number
}

export const DEFAULT_MAX_RETAINED_PAYLOAD_BYTES = 64 * 1024 * 1024
export const DEFAULT_PAYLOAD_RETENTION_AGE_MS = 30 * 24 * 60 * 60 * 1000
export const DEFAULT_PAYLOAD_RETENTION_TOTAL_BYTES = 2 * 1024 * 1024 * 1024
export const PAYLOAD_STORE_DIR_NAME = 'agent-session-payloads'

/** Refuses anything that is not a lowercase sha256, so a digest can never be
 *  used to reach outside the store's own directory. */
export function assertPayloadDigest(digest: string): void {
  if (!DIGEST_PATTERN.test(digest)) {
    throw new Error(`Invalid payload digest: ${digest}`)
  }
}

/** The non-throwing form, for validating untrusted input before it is used. */
export function isPayloadDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST_PATTERN.test(value)
}

/** Verified identities kept per store; paging a large payload is the common
 *  case and each page would otherwise re-hash the whole file. */
const VERIFICATION_CACHE_LIMIT = 64

export class JournalPayloadStore implements JournalPayloadRetention {
  private readonly directory: string
  private readonly maxRetainedBytes: number
  private readonly verified = new Map<string, VerifiedFileIdentity>()

  /** Creates the store directory 0700 on construction, so no later write has to
   *  decide the permissions of a directory holding complete payload originals. */
  constructor(options: JournalPayloadStoreOptions) {
    this.directory = options.directory
    this.maxRetainedBytes = options.maxRetainedBytes ?? DEFAULT_MAX_RETAINED_PAYLOAD_BYTES
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
  }

  /** The on-disk path for a digest. Validating first is what keeps a caller
   *  from steering a read or a write outside this store's own directory. */
  private pathFor(digest: string, suffix = PAYLOAD_SUFFIX): string {
    assertPayloadDigest(digest)
    return join(this.directory, `${digest}${suffix}`)
  }

  /** Writes the complete original under `digest`, via a temporary and a rename
   *  so no reader can observe a half-written file. Returns false — never throws
   *  — when the payload is oversized, mis-addressed, or could not be stored, so
   *  the row records `retrievable: false` rather than a retention that failed. */
  retain(digest: string, payload: string, scope?: string): boolean {
    const bytes = Buffer.from(payload, 'utf8')
    if (bytes.byteLength > this.maxRetainedBytes) {
      return false
    }
    const actual = createHash('sha256').update(bytes).digest('hex')
    if (actual !== digest) {
      return false
    }
    const path = this.pathFor(digest)
    // An existing file is trusted only after it re-hashes to the digest; an
    // equal size is not identity. A mismatch is replaced atomically, since the
    // caller holds the bytes that do hash to it.
    let stored = existsSync(path) && this.fileHashes(path, digest)
    if (!stored) {
      const temporary = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
      try {
        writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx' })
        renameSync(temporary, path)
        stored = true
      } catch {
        stored = false
        try {
          rmSync(temporary, { force: true })
        } catch {
          // The temporary is already gone or unreachable; the prune sweep also drops *.tmp.
        }
      }
    }
    if (stored && scope !== undefined) {
      this.recordScope(digest, scope)
    }
    return stored
  }

  /** Streams the file so a large retained payload never lands in memory twice. */
  private fileHashes(path: string, digest: string): boolean {
    let descriptor: number | null = null
    try {
      const size = statSync(path).size
      if (size > this.maxRetainedBytes) {
        return false
      }
      descriptor = openSync(path, 'r')
      return hashDescriptor(descriptor, size) === digest
    } catch {
      return false
    } finally {
      if (descriptor !== null) {
        closeSync(descriptor)
      }
    }
  }

  /** True when this exact file — same inode, size and mtime — already hashed to
   *  `digest`. Any rewrite moves the mtime or the inode, so the entry lapses. */
  private isVerified(digest: string, identity: VerifiedFileIdentity): boolean {
    const known = this.verified.get(digest)
    return (
      known !== undefined &&
      known.size === identity.size &&
      known.mtimeMs === identity.mtimeMs &&
      known.ino === identity.ino &&
      known.dev === identity.dev
    )
  }

  /** Pins a successful verification to the file it was computed from, evicting
   *  oldest-first. The cache is what makes paging cost one hash, not one per page. */
  private rememberVerified(digest: string, identity: VerifiedFileIdentity): void {
    this.verified.delete(digest)
    this.verified.set(digest, identity)
    // Insertion order is oldest-first, so the first key is the eviction victim.
    while (this.verified.size > VERIFICATION_CACHE_LIMIT) {
      const oldest = this.verified.keys().next()
      if (oldest.done === true) {
        break
      }
      this.verified.delete(oldest.value)
    }
  }

  /** Appends `scope` to the digest's reference index, for readers that have no
   *  journal of their own to prove ownership from. Failure is swallowed on
   *  purpose: a missing scope record only ever narrows a later read. */
  private recordScope(digest: string, scope: string): void {
    if (!SCOPE_PATTERN.test(scope)) {
      return
    }
    const path = this.pathFor(digest, SCOPES_SUFFIX)
    try {
      if (this.isReferencedBy(digest, scope)) {
        return
      }
      appendFileSync(path, `${scope}\n`, { mode: 0o600 })
    } catch {
      // A missing scope record only narrows later retrieval; it never widens it.
    }
  }

  /** True only when this exact scope was recorded against `digest`. A malformed
   *  scope, a missing index and an unreadable one all answer false. */
  isReferencedBy(digest: string, scope: string): boolean {
    if (!SCOPE_PATTERN.test(scope)) {
      return false
    }
    const path = this.pathFor(digest, SCOPES_SUFFIX)
    if (!existsSync(path)) {
      return false
    }
    try {
      return readFileSync(path, 'utf8').split('\n').includes(scope)
    } catch {
      return false
    }
  }

  /** The whole retained original, re-hashed before it is returned. Null when
   *  nothing is stored; throws rather than serve bytes that no longer match. */
  retrieve(digest: string): string | null {
    const path = this.pathFor(digest)
    if (!existsSync(path)) {
      return null
    }
    // Bound the whole-file read the same way retention is bounded.
    if (statSync(path).size > this.maxRetainedBytes) {
      throw new JournalPayloadIntegrityError(digest, 'oversized')
    }
    const bytes = readFileSync(path)
    const actual = createHash('sha256').update(bytes).digest('hex')
    if (actual !== digest) {
      throw new JournalPayloadIntegrityError(digest, actual)
    }
    return bytes.toString('utf8')
  }

  /** One page of the retained original. The WHOLE file is verified before any
   *  of it is served, so an intact-looking range out of a tampered file is never
   *  returned. Both ends of the page are aligned to UTF-8 boundaries, and the
   *  returned `chunkOffset` is where the served bytes actually start. */
  retrieveRange(digest: string, offset: number, limit: number): JournalPayloadRange | null {
    const path = this.pathFor(digest)
    if (!existsSync(path)) {
      return null
    }
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit <= 0) {
      throw new Error('Payload range offset must be a non-negative integer and limit a positive integer.')
    }
    // Verify the whole file before serving any of it: a range from a tampered
    // file must never be returned even when the requested bytes happen to be
    // intact. The verification is pinned to the file's identity, so paging a
    // large payload hashes it once instead of once per page.
    const identity = fileIdentity(path)
    const size = identity.size
    const descriptor = openSync(path, 'r')
    let chunk = Buffer.alloc(0)
    try {
      if (!this.isVerified(digest, identity)) {
        const actual = hashDescriptor(descriptor, size)
        if (actual !== digest) {
          this.verified.delete(digest)
          throw new JournalPayloadIntegrityError(digest, actual)
        }
        this.rememberVerified(digest, identity)
      }
      // A caller may page from anywhere, so the start is aligned forward to the
      // next lead byte before any of it is decoded; `chunkOffset` reports where
      // the served bytes actually begin, never the unaligned request.
      const start = alignUtf8Start(descriptor, Math.min(offset, size), size)
      const end = Math.min(size, start + limit)
      const alignedEnd = alignUtf8End(descriptor, start, end, size)
      chunk = Buffer.alloc(alignedEnd - start)
      if (chunk.byteLength > 0) {
        readSync(descriptor, chunk, 0, chunk.byteLength, start)
      }
      return {
        digest,
        byteLength: size,
        chunk: chunk.toString('utf8'),
        chunkOffset: start,
        chunkByteLength: chunk.byteLength,
        complete: alignedEnd >= size
      }
    } finally {
      closeSync(descriptor)
    }
  }

  /** Sweeps expired and over-cap files oldest-first, together with their scope
   *  records and any temporary a crashed writer left. Never called on a read path. */
  prune(options: JournalPayloadPruneOptions): JournalPayloadPruneReport {
    const now = options.now ?? Date.now()
    const entries: { digest: string; mtimeMs: number; size: number }[] = []
    for (const name of readdirSync(this.directory)) {
      if (name.endsWith('.tmp')) {
        // A temporary left by a crashed writer is never valid content.
        rmSync(join(this.directory, name), { force: true })
        continue
      }
      if (!name.endsWith(PAYLOAD_SUFFIX)) {
        continue
      }
      const digest = name.slice(0, -PAYLOAD_SUFFIX.length)
      if (!DIGEST_PATTERN.test(digest)) {
        continue
      }
      try {
        const info = statSync(join(this.directory, name))
        entries.push({ digest, mtimeMs: info.mtimeMs, size: info.size })
      } catch {
        // Removed concurrently; nothing to prune.
      }
    }
    entries.sort((left, right) => left.mtimeMs - right.mtimeMs)
    let retainedBytes = entries.reduce((total, entry) => total + entry.size, 0)
    let removed = 0
    for (const entry of entries) {
      const expired = now - entry.mtimeMs > options.maxAgeMs
      const overCap = retainedBytes > options.maxTotalBytes
      if (!expired && !overCap) {
        continue
      }
      try {
        rmSync(join(this.directory, `${entry.digest}${PAYLOAD_SUFFIX}`), { force: true })
        rmSync(join(this.directory, `${entry.digest}${SCOPES_SUFFIX}`), { force: true })
        retainedBytes -= entry.size
        removed += 1
      } catch {
        // Leave it for the next sweep.
      }
    }
    return { scanned: entries.length, removed, retainedBytes }
  }
}

export {
  getDefaultJournalPayloadRetention,
  journalPayloadDigest,
  retrieveJournalPayload,
  setDefaultJournalPayloadRetention
} from './journal-payload-retention-default'
