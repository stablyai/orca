/**
 * Decides whether a grown rollout can be parsed from where the last scan
 * stopped. A wrong answer here silently corrupts usage totals, so every check
 * fails closed: anything unproven falls back to a full reparse.
 */
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import type { CodexUsageParseContext } from './codex-usage-record-parser'
import type { CodexUsageParseResumeState, CodexUsagePersistedFile } from './types'

/** Bytes hashed immediately before the resume offset. Large enough to span a
 *  whole token_count record, small enough that verifying it is free next to
 *  re-reading a multi-megabyte rollout. */
const BOUNDARY_WINDOW_BYTES = 4096

/** Bytes hashed at the very start of the parsed prefix. The boundary window can
 *  only speak for the bytes next to the resume offset, so without this a
 *  same-length rewrite that leaves the tail intact resumes over changed
 *  history. Every realistic rotation or rewrite of a rollout replaces the
 *  leading session_meta line, which lands in this window. */
const HEAD_WINDOW_BYTES = 4096

/**
 * Shortest prefix worth resuming over. A resumed scan verifies the prefix
 * twice — once when the scanner plans the resume, once against the file it is
 * about to read — and then records the moved boundary, so it pays five windows
 * whatever the file size. A cold reparse pays the prefix itself plus the two
 * windows it records. Below this length reading the whole file is cheaper, and
 * for a prefix short enough that the two windows overlap it is far cheaper,
 * because each verification then rehashes the entire prefix.
 *
 * Measured on the byte oracle: a 12,191 B prefix costs 21,234 B resumed against
 * 21,137 B cold; at 13,699 B it is 21,234 B against 22,645 B.
 */
export const MIN_RESUMABLE_PREFIX_BYTES = 3 * BOUNDARY_WINDOW_BYTES

/** Below the floor the two windows could also overlap, so every offset that
 *  reaches the digest reads is guaranteed to give them a disjoint layout. */
export function isResumablePrefixLength(parsedBytes: number): boolean {
  return parsedBytes > MIN_RESUMABLE_PREFIX_BYTES
}

async function readWindowDigest(
  filePath: string,
  start: number,
  endExclusive: number
): Promise<string | null> {
  const expectedBytes = endExclusive - start
  const hash = createHash('sha256')
  let readBytes = 0
  const stream = createReadStream(filePath, { start, end: endExclusive - 1 })
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    hash.update(buffer)
    readBytes += buffer.length
  }
  // A short read means the file no longer reaches the offset we recorded.
  return readBytes === expectedBytes ? `${expectedBytes}:${hash.digest('hex')}` : null
}

type PrefixDigests = { headDigest: string; boundaryDigest: string }

/**
 * Both window digests for a prefix of `parsedBytes`, or null if the file no
 * longer reaches that offset. The window layout is a pure function of
 * `parsedBytes`, so a later verification hashes exactly the same ranges. Only
 * called for a prefix past `MIN_RESUMABLE_PREFIX_BYTES`, so the two windows are
 * always disjoint and always their full size.
 *
 * `carriedHeadDigest` lets a caller that already verified the head window this
 * scan skip re-reading those bytes. Deferring to it is self-correcting: if the
 * head did change after that read, the next scan compares against the carried
 * value and falls back to a full reparse.
 */
async function readPrefixDigests(
  filePath: string,
  parsedBytes: number,
  carriedHeadDigest: string | null = null
): Promise<PrefixDigests | null> {
  const headDigest = carriedHeadDigest?.startsWith(`${HEAD_WINDOW_BYTES}:`)
    ? carriedHeadDigest
    : await readWindowDigest(filePath, 0, HEAD_WINDOW_BYTES)
  if (headDigest === null) {
    return null
  }
  const boundaryDigest = await readWindowDigest(
    filePath,
    parsedBytes - BOUNDARY_WINDOW_BYTES,
    parsedBytes
  )
  return boundaryDigest === null ? null : { headDigest, boundaryDigest }
}

async function readPhysicalFileId(filePath: string): Promise<string | null> {
  try {
    const fileStat = await stat(filePath)
    return fileStat.ino === 0 ? null : `${fileStat.dev}:${fileStat.ino}`
  } catch {
    return null
  }
}

function isUsableResumeState(
  resume: CodexUsageParseResumeState | null | undefined
): resume is CodexUsageParseResumeState {
  return (
    resume != null &&
    Number.isInteger(resume.parsedBytes) &&
    resume.parsedBytes >= 0 &&
    typeof resume.boundaryDigest === 'string' &&
    // State persisted before the head window existed cannot be verified.
    typeof resume.headDigest === 'string' &&
    // Caches written before the floor existed can hold a shorter prefix.
    isResumablePrefixLength(resume.parsedBytes) &&
    typeof resume.sessionId === 'string'
  )
}

export async function buildCodexRolloutResumeState(
  filePath: string,
  parsedBytes: number,
  context: CodexUsageParseContext,
  verifiedHeadDigest: string | null = null
): Promise<CodexUsageParseResumeState | null> {
  if (!isResumablePrefixLength(parsedBytes)) {
    return null
  }
  const digests = await readPrefixDigests(filePath, parsedBytes, verifiedHeadDigest)
  if (digests === null) {
    return null
  }
  return {
    parsedBytes,
    boundaryDigest: digests.boundaryDigest,
    headDigest: digests.headDigest,
    physicalFileId: await readPhysicalFileId(filePath),
    sessionId: context.sessionId,
    sessionCwd: context.sessionCwd,
    currentCwd: context.currentCwd,
    currentModel: context.currentModel,
    previousTotals: context.previousTotals
  }
}

/**
 * Returns the resume point only when the recorded prefix still looks like the
 * file's prefix. Deliberately does not consult any timestamp: filesystems vary
 * in clock granularity, so a rewrite can land under the mtime, ctime or
 * birthtime the cache already holds. `physicalFileId` is a cheap extra catch
 * rather than a rotation check — ext4 and overlayfs hand a recreated path the
 * inode the old file freed, so it only fires on filesystems that allocate a
 * fresh one. Truncation needs no separate check: a file that no longer reaches
 * the offset cannot produce the recorded digests.
 *
 * Bounded by design, so for a prefix larger than the two windows together this
 * cannot prove every byte between them is intact.
 */
export async function resolveCodexRolloutResume(
  filePath: string,
  previous: CodexUsagePersistedFile | undefined
): Promise<CodexUsageParseResumeState | null> {
  const resume = previous?.parseResumeState
  if (!isUsableResumeState(resume)) {
    return null
  }
  const physicalFileId = await readPhysicalFileId(filePath)
  if (
    resume.physicalFileId !== null &&
    physicalFileId !== null &&
    resume.physicalFileId !== physicalFileId
  ) {
    return null
  }
  const digests = await readPrefixDigests(filePath, resume.parsedBytes)
  if (digests === null) {
    return null
  }
  return digests.boundaryDigest === resume.boundaryDigest &&
    digests.headDigest === resume.headDigest
    ? resume
    : null
}
