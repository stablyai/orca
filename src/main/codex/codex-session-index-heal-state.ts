import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  isPathInsideOrEqual,
  normalizeRuntimePathForComparison
} from '../../shared/cross-platform-path'
import { writeFileAtomically } from '../codex-accounts/fs-utils'

// State files for the session index heal: which backfilled rollouts exist
// (the backfill audit ledger), which thread ids this pass already processed
// (the heal ledger), and the completion marker that makes steady-state
// startups a two-stat no-op.

// Bump to re-drive the heal for every host after a semantics change; already
// processed thread ids are re-read because ledger lines are version-scoped.
export const CODEX_SESSION_INDEX_HEAL_VERSION = 3

// Why: an unsupported CLI stays unsupported until upgraded; re-probing once a
// day is enough to notice an upgrade without a per-startup spawn.
const HEAL_UNSUPPORTED_RETRY_INTERVAL_MS = 24 * 60 * 60 * 1000
const HEAL_FAILED_THREAD_RETRY_INTERVAL_MS = 24 * 60 * 60 * 1000

const CODEX_ROLLOUT_THREAD_ID_PATTERN =
  /^rollout-(.+)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i

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

/**
 * Diffs the backfill audit ledger against the heal ledger: every hardlinked or
 * copied rollout whose thread id has not been processed yet, most recent first.
 */
export function collectPendingHealThreads(paths: CodexSessionIndexHealPaths): PendingHealThread[] {
  const processed = readProcessedHealThreads(paths)
  const pendingByThreadId = new Map<string, PendingHealThread>()
  for (const line of readJsonlLines(paths.auditLogPath, true)) {
    if (line.action !== 'hardlink' && line.action !== 'copy' && line.action !== 'existing') {
      continue
    }
    if (typeof line.target !== 'string') {
      continue
    }
    // Why: the append-only audit can contain runs for several custom Codex
    // homes; only thread/read ids whose rollout lives in this invocation's DB.
    if (!isPathInsideOrEqual(paths.systemSessionsRoot, line.target)) {
      continue
    }
    const match = CODEX_ROLLOUT_THREAD_ID_PATTERN.exec(lastPathSegment(line.target))
    if (!match) {
      continue
    }
    const threadId = match[2].toLowerCase()
    const auditRecordId = typeof line.recordId === 'string' ? line.recordId : null
    if (
      processed.healedThreadIds.has(threadId) ||
      (auditRecordId
        ? processed.missingAuditRecords.has(`${threadId}\0${auditRecordId}`)
        : processed.legacyMissingThreadIds.has(threadId))
    ) {
      // Why: only the newest publication event for a thread matters. A later
      // processed event must displace an older pending event from this scan.
      pendingByThreadId.delete(threadId)
      continue
    }
    pendingByThreadId.set(threadId, { threadId, rolloutStamp: match[1], auditRecordId })
  }
  return [...pendingByThreadId.values()].sort((left, right) =>
    left.rolloutStamp < right.rolloutStamp ? 1 : left.rolloutStamp > right.rolloutStamp ? -1 : 0
  )
}

function lastPathSegment(filePath: string): string {
  return filePath.split(/[\\/]/).at(-1) ?? ''
}

function readProcessedHealThreads(paths: CodexSessionIndexHealPaths): {
  healedThreadIds: Set<string>
  missingAuditRecords: Set<string>
  legacyMissingThreadIds: Set<string>
} {
  const healedThreadIds = new Set<string>()
  const missingAuditRecords = new Set<string>()
  const legacyMissingThreadIds = new Set<string>()
  const expectedRoot = normalizeRuntimePathForComparison(paths.systemSessionsRoot)
  for (const line of readJsonlLines(paths.healLedgerPath)) {
    if (
      line.v === CODEX_SESSION_INDEX_HEAL_VERSION &&
      typeof line.threadId === 'string' &&
      typeof line.systemSessionsRoot === 'string' &&
      (line.outcome === 'healed' || line.outcome === 'missing') &&
      normalizeRuntimePathForComparison(line.systemSessionsRoot) === expectedRoot
    ) {
      const threadId = line.threadId.toLowerCase()
      if (line.outcome === 'healed') {
        healedThreadIds.add(threadId)
      } else if (typeof line.auditRecordId === 'string') {
        missingAuditRecords.add(`${threadId}\0${line.auditRecordId}`)
      } else {
        legacyMissingThreadIds.add(threadId)
      }
    }
  }
  return { healedThreadIds, missingAuditRecords, legacyMissingThreadIds }
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
      // Why: a killed process can leave a torn tail. Start on a fresh line so
      // the durable outcome cannot be swallowed by that corrupt fragment.
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
    // Why: the completion marker may only cover durably recorded outcomes;
    // otherwise its audit-size fast path permanently suppresses the retry.
    console.warn('[codex-session-index-heal] Failed to append heal ledger record:', error)
    return false
  }
}

function readJsonlLines(filePath: string, throwOnReadFailure = false): Record<string, unknown>[] {
  let contents: string
  try {
    contents = readFileSync(filePath, 'utf-8')
  } catch (error) {
    if (throwOnReadFailure && !isNotFoundError(error)) {
      // Why: the audit is the heal work queue. Treating EACCES/EIO as empty
      // would write a completion marker that permanently skips every session.
      throw error
    }
    return []
  }
  const lines: Record<string, unknown>[] = []
  for (const raw of contents.split('\n')) {
    if (!raw.trim()) {
      continue
    }
    try {
      const parsed: unknown = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        lines.push(parsed as Record<string, unknown>)
      }
    } catch {
      // Skip torn/corrupt lines; both ledgers are append-only diagnostics.
    }
  }
  return lines
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
    if (
      marker.version !== CODEX_SESSION_INDEX_HEAL_VERSION ||
      marker.systemSessionsRoot !== paths.systemSessionsRoot
    ) {
      return false
    }
    if (typeof marker.unsupportedAt === 'number') {
      return Date.now() - marker.unsupportedAt < HEAL_UNSUPPORTED_RETRY_INTERVAL_MS
    }
    if (typeof marker.retryableFailureAt === 'number') {
      // Why: malformed or still-growing rollouts must be retried eventually,
      // but a permanently bad file must not spawn an app-server every launch.
      return (
        marker.auditBytes === auditBytes &&
        Date.now() - marker.retryableFailureAt < HEAL_FAILED_THREAD_RETRY_INTERVAL_MS
      )
    }
    // Why: the audit ledger is append-only, so an unchanged byte size means no
    // new backfilled sessions since this marker was written.
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
