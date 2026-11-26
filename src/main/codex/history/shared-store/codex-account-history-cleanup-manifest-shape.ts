import type { CodexHistoryCleanupManifest } from './codex-account-history-cleanup-manifest'

export const MANIFEST_VERSION = 1

// Older builds' cleanup deletes on these fields, so a manifest missing or mistyping any is rebuilt.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isFileFacts(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.path === 'string' &&
    typeof value.bytes === 'number' &&
    typeof value.mtimeMs === 'number'
  )
}

function isTimestampOrNull(value: unknown): boolean {
  return value === null || (typeof value === 'string' && Number.isFinite(Date.parse(value)))
}

function isContentCheck(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.at === 'string' &&
    typeof value.sameContent === 'boolean' &&
    typeof value.sha256 === 'string' &&
    isFileFacts(value.store) &&
    (value.transientFailures === undefined || typeof value.transientFailures === 'number')
  )
}

// Every field an older build's pass or cleanup reads; anything else is rebuilt from disk.
function isLeftBehindRollout(value: unknown): boolean {
  return (
    isFileFacts(value) &&
    isRecord(value) &&
    (value.kind === 'set-aside-twin' || value.kind === 'merge-conflict') &&
    (value.storePath === null || typeof value.storePath === 'string') &&
    (value.check === null || isContentCheck(value.check))
  )
}

export function isCurrentManifest(value: unknown): value is CodexHistoryCleanupManifest {
  return (
    isRecord(value) &&
    value.version === MANIFEST_VERSION &&
    typeof value.storeHome === 'string' &&
    isTimestampOrNull(value.firstSharedAt) &&
    isTimestampOrNull(value.lastSharedAt) &&
    typeof value.sharedPasses === 'number' &&
    Array.isArray(value.rollouts) &&
    value.rollouts.every(isLeftBehindRollout) &&
    Array.isArray(value.databases) &&
    value.databases.every(isFileFacts) &&
    Array.isArray(value.storeTwinPairs) &&
    value.storeTwinPairs.every((path) => typeof path === 'string')
  )
}
