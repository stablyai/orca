import { normalizeRuntimePathForComparison } from '../../../../shared/file-access/cross-platform-path'
import {
  bufferSliceContains,
  forEachCodexSessionLedgerRecord
} from '../rollouts/codex-session-ledger-stream'
import {
  bufferSliceEquals,
  createFlatJsonFieldSlot,
  scanFlatJsonObjectBuffer
} from '../rollouts/flat-json-object-buffer-scan'

const UNICODE_ESCAPE_BYTES = Buffer.from('\\u')
const HEALED_BYTES = Buffer.from('healed')
const MISSING_BYTES = Buffer.from('missing')

export type ProcessedHealThreads = {
  healedAuditRecords: Set<string>
  legacyHealedThreadIds: Set<string>
  missingAuditRecords: Set<string>
  legacyMissingThreadIds: Set<string>
}

export async function readProcessedHealThreads(
  healLedgerPath: string,
  systemSessionsRoot: string,
  healVersion: number
): Promise<ProcessedHealThreads> {
  const healedAuditRecords = new Set<string>()
  const legacyHealedThreadIds = new Set<string>()
  const missingAuditRecords = new Set<string>()
  const legacyMissingThreadIds = new Set<string>()
  const expectedRoot = normalizeRuntimePathForComparison(systemSessionsRoot)
  const expectedRootBytes = Buffer.from(systemSessionsRoot, 'utf-8')
  const expectedVersionBytes = Buffer.from(String(healVersion), 'ascii')

  const recordOutcome = (
    rawThreadId: string,
    isHealed: boolean,
    auditRecordId: string | null
  ): void => {
    const threadId = rawThreadId.toLowerCase()
    if (isHealed) {
      if (auditRecordId !== null) {
        healedAuditRecords.add(`${threadId}\0${auditRecordId}`)
      } else {
        legacyHealedThreadIds.add(threadId)
      }
    } else if (auditRecordId !== null) {
      missingAuditRecords.add(`${threadId}\0${auditRecordId}`)
    } else {
      legacyMissingThreadIds.add(threadId)
    }
  }

  const slots = [
    createFlatJsonFieldSlot('v'),
    createFlatJsonFieldSlot('threadId'),
    createFlatJsonFieldSlot('systemSessionsRoot'),
    createFlatJsonFieldSlot('outcome'),
    createFlatJsonFieldSlot('auditRecordId')
  ] as const
  const [versionSlot, threadIdSlot, rootSlot, outcomeSlot, auditRecordIdSlot] = slots

  await forEachCodexSessionLedgerRecord(
    healLedgerPath,
    (line) => {
      if (
        line.v === healVersion &&
        typeof line.threadId === 'string' &&
        typeof line.systemSessionsRoot === 'string' &&
        (line.outcome === 'healed' || line.outcome === 'missing') &&
        normalizeRuntimePathForComparison(line.systemSessionsRoot) === expectedRoot
      ) {
        recordOutcome(
          line.threadId,
          line.outcome === 'healed',
          typeof line.auditRecordId === 'string' ? line.auditRecordId : null
        )
      }
    },
    {
      shouldParseBuffer: (buf, start, end) =>
        bufferSliceContains(buf, start, end, HEALED_BYTES) ||
        bufferSliceContains(buf, start, end, MISSING_BYTES) ||
        bufferSliceContains(buf, start, end, UNICODE_ESCAPE_BYTES),
      onLineBuffer: (buf, start, end) => {
        if (!scanFlatJsonObjectBuffer(buf, start, end, slots)) {
          return false
        }
        if (versionSlot.isString || versionSlot.valueStart === -1) {
          return true
        }
        if (
          !bufferSliceEquals(
            buf,
            versionSlot.valueStart,
            versionSlot.valueEnd,
            expectedVersionBytes
          )
        ) {
          for (let i = versionSlot.valueStart; i < versionSlot.valueEnd; i += 1) {
            const b = buf[i]
            if (b === 0x2e || b === 0x65 || b === 0x45) {
              return false
            }
          }
          return true
        }
        if (!threadIdSlot.isString || !rootSlot.isString || !outcomeSlot.isString) {
          return true
        }
        const isHealed = bufferSliceEquals(
          buf,
          outcomeSlot.valueStart,
          outcomeSlot.valueEnd,
          HEALED_BYTES
        )
        const isMissing =
          !isHealed &&
          bufferSliceEquals(buf, outcomeSlot.valueStart, outcomeSlot.valueEnd, MISSING_BYTES)
        if (!isHealed && !isMissing) {
          return true
        }
        const rootMatches =
          bufferSliceEquals(buf, rootSlot.valueStart, rootSlot.valueEnd, expectedRootBytes) ||
          normalizeRuntimePathForComparison(
            buf.toString('utf-8', rootSlot.valueStart, rootSlot.valueEnd)
          ) === expectedRoot
        if (!rootMatches) {
          return true
        }
        recordOutcome(
          buf.toString('utf-8', threadIdSlot.valueStart, threadIdSlot.valueEnd),
          isHealed,
          auditRecordIdSlot.isString
            ? buf.toString('utf-8', auditRecordIdSlot.valueStart, auditRecordIdSlot.valueEnd)
            : null
        )
        return true
      }
    }
  )
  return {
    healedAuditRecords,
    legacyHealedThreadIds,
    missingAuditRecords,
    legacyMissingThreadIds
  }
}
