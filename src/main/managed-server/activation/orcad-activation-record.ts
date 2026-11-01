// Keep activation identity, rollback target and state snapshot outside version directories so GC cannot erase recovery metadata.
import { remoteInstallDirName, ORCAD_INSTALL_MODEL } from '../install/remote-install-model'

export const ORCAD_ACTIVATION_FILENAME = 'orcad-active.json'
export const ORCAD_ACTIVATION_SCHEMA_VERSION = 1

export const ORCAD_STATE_SNAPSHOT_DIR = 'orcad-state-snapshots'

export type OrcadStateSnapshot = {
  dirName: string
  /** Activation this snapshot precedes. */
  takenBeforeVersion: string
  /** Build that produced this state and can read it during rollback. */
  readableByVersion: string | null
  takenAt: string
}

export type OrcadActivationRecord = {
  schemaVersion: typeof ORCAD_ACTIVATION_SCHEMA_VERSION
  /** Content-hashed install version; null before activation or after decommission. */
  active: string | null
  /** Rollback target, pinned against GC. */
  previous: string | null
  activatedAt: string | null
  snapshot: OrcadStateSnapshot | null
  /** Optional app provenance; older builds omit it, so mixed-version readers must tolerate absence. */
  activeAppVersion?: string
  previousAppVersion?: string
  /** Explicit rollback suppresses reconnect auto-reactivation of this build. */
  rolledBackFrom?: string
}

export function emptyOrcadActivationRecord(): OrcadActivationRecord {
  return {
    schemaVersion: ORCAD_ACTIVATION_SCHEMA_VERSION,
    active: null,
    previous: null,
    activatedAt: null,
    snapshot: null
  }
}

/** Distinguish absent from unreadable so older clients cannot deploy over records they cannot interpret. */
export type OrcadActivationReadResult =
  | { state: 'absent' }
  | { state: 'ok'; record: OrcadActivationRecord }
  | { state: 'unreadable'; reason: string }

export function parseOrcadActivationRecord(raw: string | null): OrcadActivationReadResult {
  if (raw === null || raw.trim() === '') {
    return { state: 'absent' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return {
      state: 'unreadable',
      reason: `activation record is not JSON: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { state: 'unreadable', reason: 'activation record is not an object' }
  }
  const record = parsed as Partial<OrcadActivationRecord>
  if (record.schemaVersion !== ORCAD_ACTIVATION_SCHEMA_VERSION) {
    return {
      state: 'unreadable',
      reason:
        `activation record schemaVersion ${String(record.schemaVersion)} is not ` +
        `${ORCAD_ACTIVATION_SCHEMA_VERSION}; this client cannot safely interpret it`
    }
  }
  return {
    state: 'ok',
    record: {
      schemaVersion: ORCAD_ACTIVATION_SCHEMA_VERSION,
      active: typeof record.active === 'string' ? record.active : null,
      previous: typeof record.previous === 'string' ? record.previous : null,
      activatedAt: typeof record.activatedAt === 'string' ? record.activatedAt : null,
      snapshot: parseSnapshot(record.snapshot),
      ...(typeof record.activeAppVersion === 'string'
        ? { activeAppVersion: record.activeAppVersion }
        : {}),
      ...(typeof record.previousAppVersion === 'string'
        ? { previousAppVersion: record.previousAppVersion }
        : {}),
      ...(typeof record.rolledBackFrom === 'string'
        ? { rolledBackFrom: record.rolledBackFrom }
        : {})
    }
  }
}

function parseSnapshot(value: unknown): OrcadStateSnapshot | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const snapshot = value as Partial<OrcadStateSnapshot>
  if (typeof snapshot.dirName !== 'string' || typeof snapshot.takenBeforeVersion !== 'string') {
    return null
  }
  return {
    dirName: snapshot.dirName,
    takenBeforeVersion: snapshot.takenBeforeVersion,
    readableByVersion:
      typeof snapshot.readableByVersion === 'string' ? snapshot.readableByVersion : null,
    takenAt: typeof snapshot.takenAt === 'string' ? snapshot.takenAt : ''
  }
}

/** Omit advisory fields dropped by older peers so their journals still match the committed core record. */
export function coreOrcadActivationRecord(record: OrcadActivationRecord): OrcadActivationRecord {
  const {
    activeAppVersion: _app,
    previousAppVersion: _prev,
    rolledBackFrom: _held,
    ...core
  } = record
  return core
}

export function serializeOrcadActivationRecord(record: OrcadActivationRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`
}

export function withActivatedVersion(
  record: OrcadActivationRecord,
  version: string,
  snapshot: OrcadStateSnapshot | null,
  now: Date,
  appVersion?: string
): OrcadActivationRecord {
  const same = record.active === version
  // A decommissioned record can retain app provenance without naming an active predecessor.
  const previousAppVersion = same
    ? record.previousAppVersion
    : record.active
      ? record.activeAppVersion
      : undefined
  return {
    schemaVersion: ORCAD_ACTIVATION_SCHEMA_VERSION,
    active: version,
    // Re-activating identical bytes must preserve the existing rollback target.
    previous: same ? record.previous : record.active,
    activatedAt: now.toISOString(),
    snapshot: same ? record.snapshot : snapshot,
    ...(appVersion ? { activeAppVersion: appVersion } : {}),
    ...(previousAppVersion ? { previousAppVersion } : {})
  }
}

export function withRolledBackVersion(
  record: OrcadActivationRecord,
  now: Date
): OrcadActivationRecord {
  return {
    schemaVersion: ORCAD_ACTIVATION_SCHEMA_VERSION,
    active: record.previous,
    // Rolling back must not offer the failed build as the next rollback target.
    previous: null,
    activatedAt: now.toISOString(),
    // Restoring consumes the snapshot taken before the outgoing build ran.
    snapshot: null,
    ...(record.previousAppVersion ? { activeAppVersion: record.previousAppVersion } : {}),
    ...(record.active ? { rolledBackFrom: record.active } : {})
  }
}

export function withDeactivatedVersion(record: OrcadActivationRecord): OrcadActivationRecord {
  return {
    schemaVersion: ORCAD_ACTIVATION_SCHEMA_VERSION,
    active: null,
    // Pin the stopped build for redeploy and any daemon still using its entry.
    previous: record.active,
    activatedAt: null,
    snapshot: null
  }
}

/** Commit-only provenance; never journal it because released peers compare core-only stop records byte for byte. */
export function withDeactivatedVersionCommitted(
  record: OrcadActivationRecord
): OrcadActivationRecord {
  return {
    ...withDeactivatedVersion(record),
    // Newer state may survive decommission; preserve provenance so older planners still refuse it.
    ...(record.activeAppVersion ? { activeAppVersion: record.activeAppVersion } : {}),
    ...(record.rolledBackFrom ? { rolledBackFrom: record.rolledBackFrom } : {})
  }
}

/** Pin rollback bytes and any outgoing bundle still serving a live daemon. */
export function orcadGcPinnedDirNames(
  record: OrcadActivationRecord,
  daemonEntryVersion?: string | null
): string[] {
  return orcadInstallDirNames([record.active, record.previous, daemonEntryVersion])
}

export function orcadInstallDirNames(versions: readonly (string | null | undefined)[]): string[] {
  const named = versions.filter((v): v is string => typeof v === 'string' && v.length > 0)
  return [...new Set(named)].map((version) => remoteInstallDirName(ORCAD_INSTALL_MODEL, version))
}
