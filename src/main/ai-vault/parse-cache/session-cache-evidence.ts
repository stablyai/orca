import type { AiVaultSession } from '../../../shared/ai-vault/contracts/ai-vault-types'
import type { PersistedSessionParseCacheEntry } from './session-parse-cache-store'
import { parsePersistedSidecar } from './session-sidecar-stat'
import {
  mergeSkippedTranscriptRecords,
  type SkippedTranscriptRecord
} from '../transcripts/session-transcript-record-budget'
import { sessionFileIdentity, type SessionFileIdentity } from './session-file-version'

export function parseSessionCacheIdentity(value: unknown): SessionFileIdentity {
  if (typeof value !== 'string') {
    return {}
  }
  try {
    const parsed: unknown = JSON.parse(value)
    if (typeof parsed !== 'object' || parsed === null) {
      return {}
    }
    return sessionFileIdentity({
      dev: 'dev' in parsed && typeof parsed.dev === 'number' ? parsed.dev : undefined,
      ino: 'ino' in parsed && typeof parsed.ino === 'number' ? parsed.ino : undefined,
      birthtimeMs:
        'birthtimeMs' in parsed && typeof parsed.birthtimeMs === 'number'
          ? parsed.birthtimeMs
          : undefined
    })
  } catch {
    return {}
  }
}

export function parsePersistedSessionParseCacheRow(
  item: unknown
): [string, PersistedSessionParseCacheEntry] | null {
  if (!Array.isArray(item) || item.length !== 2) {
    return null
  }
  const [path, entry]: unknown[] = item
  if (typeof path !== 'string' || !isRecord(entry)) {
    return null
  }
  const { mtimeMs, sizeBytes, platform, session } = entry
  if (
    typeof mtimeMs !== 'number' ||
    (sizeBytes !== null && typeof sizeBytes !== 'number') ||
    typeof platform !== 'string' ||
    (session !== null && !isRecord(session))
  ) {
    return null
  }
  const sidecar = parsePersistedSidecar(entry.sidecar)
  const skippedRecords: SkippedTranscriptRecord[] = []
  if (entry.skippedRecords !== undefined) {
    if (!Array.isArray(entry.skippedRecords)) {
      return null
    }
    for (const record of entry.skippedRecords) {
      if (
        !isRecord(record) ||
        typeof record.byteOffset !== 'number' ||
        !Number.isSafeInteger(record.byteOffset) ||
        record.byteOffset < 0 ||
        typeof record.approximateBytes !== 'number' ||
        !Number.isSafeInteger(record.approximateBytes) ||
        record.approximateBytes <= 0
      ) {
        return null
      }
      skippedRecords.push({
        byteOffset: record.byteOffset,
        approximateBytes: record.approximateBytes
      })
    }
  }
  return [
    path,
    {
      ...sessionFileIdentity(entry),
      mtimeMs,
      sizeBytes,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only ever compared for equality with process.platform, so an unknown value is a miss, not a misuse.
      platform: platform as NodeJS.Platform,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: written only from AiVaultSession values by this build or one with the same schema version; a semantics change bumps the version and drops the rows.
      session: session as AiVaultSession | null,
      skippedRecords: mergeSkippedTranscriptRecords([], skippedRecords),
      ...(sidecar === undefined ? {} : { sidecar })
    }
  ]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
