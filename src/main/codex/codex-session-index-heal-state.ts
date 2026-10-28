import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  isPathInsideOrEqual,
  normalizeRuntimePathForComparison
} from '../../shared/cross-platform-path'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import { streamCodexSessionLedgerRecords } from './codex-session-ledger-stream'

// Bump after semantics changes to retry outcomes recorded under older versions.
export const CODEX_SESSION_INDEX_HEAL_VERSION = 3

// Daily probes detect CLI upgrades without spawning on every startup.
const HEAL_UNSUPPORTED_RETRY_INTERVAL_MS = 24 * 60 * 60 * 1000
const HEAL_FAILED_THREAD_RETRY_INTERVAL_MS = 24 * 60 * 60 * 1000

const CODEX_ROLLOUT_THREAD_ID_PATTERN =
  /^rollout-(.+)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(?:\.zst)?$/i

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
  const processed = await readProcessedHealThreads(paths)
  const pendingByThreadId = new Map<string, PendingHealThread>()
  for await (const line of streamCodexSessionLedgerRecords(paths.auditLogPath, {
    throwOnReadFailure: true
  })) {
    if (line.action !== 'hardlink' && line.action !== 'copy' && line.action !== 'existing') {
      continue
    }
    if (typeof line.target !== 'string') {
      continue
    }
    // The audit spans custom homes; only index rollouts in this invocation's target.
    if (!isPathInsideOrEqual(paths.systemSessionsRoot, line.target)) {
      continue
    }
    const rollout = parseCodexRolloutThreadId(line.target)
    if (!rollout) {
      continue
    }
    const { threadId } = rollout
    const auditRecordId = typeof line.recordId === 'string' ? line.recordId : null
    if (
      auditRecordId
        ? processed.healedAuditRecords.has(`${threadId}\0${auditRecordId}`) ||
          processed.missingAuditRecords.has(`${threadId}\0${auditRecordId}`)
        : processed.legacyHealedThreadIds.has(threadId) ||
          processed.legacyMissingThreadIds.has(threadId)
    ) {
      // A newer processed publication displaces any older pending event for this thread.
      pendingByThreadId.delete(threadId)
      continue
    }
    pendingByThreadId.set(threadId, { threadId, rolloutStamp: rollout.rolloutStamp, auditRecordId })
  }
  return [...pendingByThreadId.values()].sort((left, right) =>
    left.rolloutStamp < right.rolloutStamp ? 1 : left.rolloutStamp > right.rolloutStamp ? -1 : 0
  )
}

export function parseCodexRolloutThreadId(
  filePath: string
): { threadId: string; rolloutStamp: string } | null {
  const match = CODEX_ROLLOUT_THREAD_ID_PATTERN.exec(lastPathSegment(filePath))
  return match ? { threadId: match[2].toLowerCase(), rolloutStamp: match[1] } : null
}

function lastPathSegment(filePath: string): string {
  return filePath.split(/[\\/]/).at(-1) ?? ''
}

async function readProcessedHealThreads(paths: CodexSessionIndexHealPaths): Promise<{
  healedAuditRecords: Set<string>
  legacyHealedThreadIds: Set<string>
  missingAuditRecords: Set<string>
  legacyMissingThreadIds: Set<string>
}> {
  const healedAuditRecords = new Set<string>()
  const legacyHealedThreadIds = new Set<string>()
  const missingAuditRecords = new Set<string>()
  const legacyMissingThreadIds = new Set<string>()
  const expectedRoot = normalizeRuntimePathForComparison(paths.systemSessionsRoot)
  for await (const line of streamCodexSessionLedgerRecords(paths.healLedgerPath)) {
    if (
      line.v === CODEX_SESSION_INDEX_HEAL_VERSION &&
      typeof line.threadId === 'string' &&
      typeof line.systemSessionsRoot === 'string' &&
      (line.outcome === 'healed' || line.outcome === 'missing') &&
      normalizeRuntimePathForComparison(line.systemSessionsRoot) === expectedRoot
    ) {
      const threadId = line.threadId.toLowerCase()
      if (line.outcome === 'healed') {
        if (typeof line.auditRecordId === 'string') {
          healedAuditRecords.add(`${threadId}\0${line.auditRecordId}`)
        } else {
          legacyHealedThreadIds.add(threadId)
        }
      } else if (typeof line.auditRecordId === 'string') {
        missingAuditRecords.add(`${threadId}\0${line.auditRecordId}`)
      } else {
        legacyMissingThreadIds.add(threadId)
      }
    }
  }
  return {
    healedAuditRecords,
    legacyHealedThreadIds,
    missingAuditRecords,
    legacyMissingThreadIds
  }
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
