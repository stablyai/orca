import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  createNormalizedPathInsideOrEqualMatcher,
  normalizeRuntimePathForComparison
} from '../../../../shared/file-access/cross-platform-path'
import { writeFileAtomically } from '../../../filesystem/atomic-file-publication'
import {
  bufferSliceContains,
  forEachCodexSessionLedgerRecord
} from '../rollouts/codex-session-ledger-stream'
import {
  bufferSliceEquals,
  createFlatJsonFieldSlot,
  scanFlatJsonObjectBuffer
} from '../rollouts/flat-json-object-buffer-scan'
import { parseCodexRolloutThreadId } from '../rollouts/codex-rollout-thread-id'
import { readProcessedHealThreads } from './codex-session-index-heal-ledger-read'

const UNICODE_ESCAPE_BYTES = Buffer.from('\\u')
const TARGET_BYTES = Buffer.from('target')
const HARDLINK_BYTES = Buffer.from('hardlink')
const COPY_BYTES = Buffer.from('copy')
const EXISTING_BYTES = Buffer.from('existing')

// Bump after semantics changes to retry outcomes recorded under older versions.
export const CODEX_SESSION_INDEX_HEAL_VERSION = 3

// Daily probes detect CLI upgrades without spawning on every startup.
const HEAL_UNSUPPORTED_RETRY_INTERVAL_MS = 24 * 60 * 60 * 1000
const HEAL_FAILED_THREAD_RETRY_INTERVAL_MS = 24 * 60 * 60 * 1000

export type CodexSessionIndexHealPaths = {
  auditLogPath: string
  systemSessionsRoot: string
  healLedgerPath: string
  healMarkerPath: string
}

export type HealLedgerOutcome = 'healed' | 'missing' | 'failed'

export type PendingHealThread = {
  threadId: string
  /** Timestamp segment of the rollout file name; lexicographic recency order. */
  rolloutStamp: string
  /** Publication event identity; null only for audit records written before event ids. */
  auditRecordId: string | null
}

export type HealMarkerSummary = {
  healedThreads: number
  missingThreads: number
  failedThreads: number
}

export async function collectPendingHealThreads(
  paths: CodexSessionIndexHealPaths
): Promise<PendingHealThread[]> {
  const processed = await readProcessedHealThreads(
    paths.healLedgerPath,
    paths.systemSessionsRoot,
    CODEX_SESSION_INDEX_HEAL_VERSION
  )
  const pendingByThreadId = new Map<string, PendingHealThread>()
  const isInsideSessionsRoot = createNormalizedPathInsideOrEqualMatcher(paths.systemSessionsRoot)
  const handleAuditEntry = (target: string, auditRecordId: string | null): void => {
    // The audit spans custom homes; only index rollouts in this invocation's target.
    if (!isInsideSessionsRoot(normalizeRuntimePathForComparison(target))) {
      return
    }
    const rollout = parseCodexRolloutThreadId(target)
    if (!rollout) {
      return
    }
    const { threadId } = rollout
    if (
      auditRecordId
        ? processed.healedAuditRecords.has(`${threadId}\0${auditRecordId}`) ||
          processed.missingAuditRecords.has(`${threadId}\0${auditRecordId}`)
        : processed.legacyHealedThreadIds.has(threadId) ||
          processed.legacyMissingThreadIds.has(threadId)
    ) {
      // A newer processed publication displaces any older pending event for this thread.
      pendingByThreadId.delete(threadId)
      return
    }
    pendingByThreadId.set(threadId, { threadId, rolloutStamp: rollout.rolloutStamp, auditRecordId })
  }
  const slots = [
    createFlatJsonFieldSlot('action'),
    createFlatJsonFieldSlot('target'),
    createFlatJsonFieldSlot('recordId')
  ] as const
  const [actionSlot, targetSlot, recordIdSlot] = slots
  const isHealActionBytes = (buf: Buffer, s: number, e: number): boolean =>
    bufferSliceEquals(buf, s, e, EXISTING_BYTES) ||
    bufferSliceEquals(buf, s, e, HARDLINK_BYTES) ||
    bufferSliceEquals(buf, s, e, COPY_BYTES)
  await forEachCodexSessionLedgerRecord(
    paths.auditLogPath,
    (line) => {
      if (
        (line.action === 'hardlink' || line.action === 'copy' || line.action === 'existing') &&
        typeof line.target === 'string'
      ) {
        handleAuditEntry(line.target, typeof line.recordId === 'string' ? line.recordId : null)
      }
    },
    {
      throwOnReadFailure: true,
      shouldParseBuffer: (buf, start, end) =>
        (bufferSliceContains(buf, start, end, TARGET_BYTES) &&
          (bufferSliceContains(buf, start, end, EXISTING_BYTES) ||
            bufferSliceContains(buf, start, end, HARDLINK_BYTES) ||
            bufferSliceContains(buf, start, end, COPY_BYTES))) ||
        bufferSliceContains(buf, start, end, UNICODE_ESCAPE_BYTES),
      onLineBuffer: (buf, start, end) => {
        if (!scanFlatJsonObjectBuffer(buf, start, end, slots)) {
          return false
        }
        if (
          actionSlot.isString &&
          targetSlot.isString &&
          isHealActionBytes(buf, actionSlot.valueStart, actionSlot.valueEnd)
        ) {
          handleAuditEntry(
            buf.toString('utf-8', targetSlot.valueStart, targetSlot.valueEnd),
            recordIdSlot.isString
              ? buf.toString('utf-8', recordIdSlot.valueStart, recordIdSlot.valueEnd)
              : null
          )
        }
        return true
      }
    }
  )
  return [...pendingByThreadId.values()].sort((left, right) =>
    left.rolloutStamp < right.rolloutStamp ? 1 : left.rolloutStamp > right.rolloutStamp ? -1 : 0
  )
}

export function appendHealLedgerRecord(
  paths: CodexSessionIndexHealPaths,
  threadId: string,
  outcome: HealLedgerOutcome,
  auditRecordId?: string | null
): boolean {
  try {
    mkdirSync(dirname(paths.healLedgerPath), { recursive: true })
    appendFileSync(
      paths.healLedgerPath,
      // A leading newline isolates this outcome from a torn ledger tail.
      `\n${JSON.stringify({
        v: CODEX_SESSION_INDEX_HEAL_VERSION,
        systemSessionsRoot: paths.systemSessionsRoot,
        threadId,
        outcome,
        ...(auditRecordId ? { auditRecordId } : {}),
        at: new Date().toISOString()
      })}\n`
    )
    return true
  } catch (error) {
    // Certifying an unrecorded outcome would permanently suppress its retry.
    console.warn('[codex-session-index-heal] Failed to append heal ledger record:', error)
    return false
  }
}

export function readAuditLogSize(auditLogPath: string): number {
  try {
    return statSync(auditLogPath).size
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error
    }
    return 0
  }
}

function isNotFoundError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

export function isHealMarkerCurrent(
  paths: CodexSessionIndexHealPaths,
  auditBytes: number
): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(paths.healMarkerPath, 'utf-8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return false
    }
    const marker = parsed as {
      version?: unknown
      systemSessionsRoot?: unknown
      auditBytes?: unknown
      unsupportedAt?: unknown
      retryableFailureAt?: unknown
    }
    // Normalize Windows path spellings to avoid repeating a heal for the same target.
    if (
      marker.version !== CODEX_SESSION_INDEX_HEAL_VERSION ||
      typeof marker.systemSessionsRoot !== 'string' ||
      normalizeRuntimePathForComparison(marker.systemSessionsRoot) !==
        normalizeRuntimePathForComparison(paths.systemSessionsRoot)
    ) {
      return false
    }
    if (typeof marker.unsupportedAt === 'number') {
      return Date.now() - marker.unsupportedAt < HEAL_UNSUPPORTED_RETRY_INTERVAL_MS
    }
    if (typeof marker.retryableFailureAt === 'number') {
      // Throttle bad-rollout retries to avoid an app-server spawn on every launch.
      return (
        marker.auditBytes === auditBytes &&
        Date.now() - marker.retryableFailureAt < HEAL_FAILED_THREAD_RETRY_INTERVAL_MS
      )
    }
    // The append-only audit changes size when new sessions are published.
    return marker.auditBytes === auditBytes
  } catch {
    return false
  }
}

export function writeHealMarker(
  paths: CodexSessionIndexHealPaths,
  auditBytes: number,
  summary: HealMarkerSummary,
  retry?: { unsupportedAt?: number; retryableFailureAt?: number }
): void {
  try {
    mkdirSync(dirname(paths.healMarkerPath), { recursive: true })
    writeFileAtomically(
      paths.healMarkerPath,
      `${JSON.stringify(
        {
          version: CODEX_SESSION_INDEX_HEAL_VERSION,
          systemSessionsRoot: paths.systemSessionsRoot,
          auditBytes,
          healedThreads: summary.healedThreads,
          missingThreads: summary.missingThreads,
          failedThreads: summary.failedThreads,
          ...(retry?.unsupportedAt === undefined ? {} : { unsupportedAt: retry.unsupportedAt }),
          ...(retry?.retryableFailureAt === undefined
            ? {}
            : { retryableFailureAt: retry.retryableFailureAt }),
          completedAt: Date.now()
        },
        null,
        2
      )}\n`
    )
  } catch (error) {
    console.warn('[codex-session-index-heal] Failed to write heal marker:', error)
  }
}
