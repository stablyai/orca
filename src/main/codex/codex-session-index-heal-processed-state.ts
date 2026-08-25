import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'

export const CODEX_SESSION_INDEX_HEAL_VERSION = 4

export type ProcessedHealThreads = {
  healedAuditRecords: Set<string>
  legacyHealedThreadIds: Set<string>
  missingAuditRecords: Set<string>
  legacyMissingThreadIds: Set<string>
  healedIdentities: Set<string>
  missingIdentities: Set<string>
  healedFileInstanceIds: Set<string>
  missingFileInstanceIds: Set<string>
  missingFileEventIds: Set<string>
}

export function collectProcessedHealThreads(args: {
  ledgerLines: readonly Record<string, unknown>[]
  auditEventByRecordId: ReadonlyMap<
    string,
    { targetPath: string; fileInstanceId?: string; fileEventId?: string }
  >
  systemSessionsRoot: string
}): ProcessedHealThreads {
  const processed: ProcessedHealThreads = {
    healedAuditRecords: new Set<string>(),
    legacyHealedThreadIds: new Set<string>(),
    missingAuditRecords: new Set<string>(),
    legacyMissingThreadIds: new Set<string>(),
    healedIdentities: new Set<string>(),
    missingIdentities: new Set<string>(),
    healedFileInstanceIds: new Set<string>(),
    missingFileInstanceIds: new Set<string>(),
    missingFileEventIds: new Set<string>()
  }
  const expectedRoot = normalizeRuntimePathForComparison(args.systemSessionsRoot)
  for (const line of args.ledgerLines) {
    if (!isProcessedLedgerLine(line, expectedRoot)) {
      continue
    }
    const threadId = line.threadId.toLowerCase()
    const legacyEvent =
      typeof line.auditRecordId === 'string'
        ? args.auditEventByRecordId.get(line.auditRecordId)
        : undefined
    const targetPath =
      typeof line.targetPath === 'string'
        ? normalizeRuntimePathForComparison(line.targetPath)
        : legacyEvent
          ? normalizeRuntimePathForComparison(legacyEvent.targetPath)
          : null
    const identity = targetPath ? `${expectedRoot}\0${threadId}\0${targetPath}` : null
    const fileInstanceId =
      typeof line.fileInstanceId === 'string'
        ? line.fileInstanceId
        : (legacyEvent?.fileInstanceId ?? null)
    const fileEventId =
      typeof line.fileEventId === 'string' ? line.fileEventId : (legacyEvent?.fileEventId ?? null)
    collectProcessedOutcome(processed, line, threadId, identity, fileInstanceId, fileEventId)
  }
  return processed
}

function isProcessedLedgerLine(
  line: Record<string, unknown>,
  expectedRoot: string
): line is Record<string, unknown> & {
  threadId: string
  systemSessionsRoot: string
  outcome: 'healed' | 'missing'
} {
  return (
    (line.v === CODEX_SESSION_INDEX_HEAL_VERSION || line.v === 3) &&
    typeof line.threadId === 'string' &&
    typeof line.systemSessionsRoot === 'string' &&
    (line.outcome === 'healed' || line.outcome === 'missing') &&
    normalizeRuntimePathForComparison(line.systemSessionsRoot) === expectedRoot
  )
}

function collectProcessedOutcome(
  processed: ProcessedHealThreads,
  line: Record<string, unknown> & { outcome: 'healed' | 'missing' },
  threadId: string,
  identity: string | null,
  fileInstanceId: string | null,
  fileEventId: string | null
): void {
  const identities =
    line.outcome === 'healed' ? processed.healedIdentities : processed.missingIdentities
  const fileInstances =
    line.outcome === 'healed' ? processed.healedFileInstanceIds : processed.missingFileInstanceIds
  const auditRecords =
    line.outcome === 'healed' ? processed.healedAuditRecords : processed.missingAuditRecords
  const legacyThreads =
    line.outcome === 'healed' ? processed.legacyHealedThreadIds : processed.legacyMissingThreadIds

  if (identity) {
    identities.add(identity)
  }
  if (fileInstanceId) {
    fileInstances.add(fileInstanceId)
  }
  if (line.outcome === 'missing' && fileEventId) {
    processed.missingFileEventIds.add(fileEventId)
  }
  if (typeof line.auditRecordId === 'string') {
    auditRecords.add(`${threadId}\0${line.auditRecordId}`)
  } else if (!identity) {
    legacyThreads.add(threadId)
  }
}
