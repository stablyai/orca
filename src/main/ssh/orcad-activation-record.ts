/**
 * Which installed orcad is the live one, and which one a rollback goes back to.
 *
 * A versioned install directory decides where bytes land; it does not decide which version
 * runs. Without this record, "roll back" means "deploy the old version again" — which needs
 * the client that has those bytes, on a host that may be the only thing still working. The
 * record is the host-side half: it names an active version, a rollback target, and the
 * pre-activation state snapshot that makes going back to that target sound.
 *
 * It lives beside the version dirs (`~/.orca-remote/orcad-active.json`), not inside one,
 * because it has to outlive whichever version GC removes.
 */
import { remoteInstallDirName, ORCAD_INSTALL_MODEL } from './remote-install-model'

export const ORCAD_ACTIVATION_FILENAME = 'orcad-active.json'
export const ORCAD_ACTIVATION_SCHEMA_VERSION = 1

/** Where a pre-activation copy of the shared data root lives, relative to `.orca-remote/`. */
export const ORCAD_STATE_SNAPSHOT_DIR = 'orcad-state-snapshots'

export type OrcadStateSnapshot = {
  /** Directory name under `ORCAD_STATE_SNAPSHOT_DIR`. */
  dirName: string
  /** The version whose activation this snapshot was taken FOR — i.e. taken before it ran. */
  takenBeforeVersion: string
  /** The version that produced the state, i.e. the rollback target it is readable by. */
  readableByVersion: string | null
  takenAt: string
}

export type OrcadActivationRecord = {
  schemaVersion: typeof ORCAD_ACTIVATION_SCHEMA_VERSION
  /** Full content-hashed version, e.g. `0.1.0+9f2a1c`. Null before the first activation. */
  active: string | null
  /** The version `active` replaced. The rollback target, and pinned against GC. */
  previous: string | null
  activatedAt: string | null
  snapshot: OrcadStateSnapshot | null
  /**
   * The Orca app versions that activated `active` and `previous`, so a client can tell a host
   * deployed by a newer Orca. Optional: builds without them write records that omit both.
   */
  activeAppVersion?: string
  previousAppVersion?: string
  /** The build an explicit rollback left; updating on connect never reactivates it. */
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

/**
 * Parse the record read off the host.
 *
 * Why a null return and not a throw on a newer schema: a client older than the host must not
 * treat "I cannot read this" as "nothing is activated" — that would deploy over a live
 * install. Callers distinguish the two through `OrcadActivationReadResult`.
 */
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

/**
 * The fields that commit an activation. Why not the advisory ones: an older client drops them
 * when it journals a record, and its journal must still match the record on the host.
 */
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

/** The record that results from activating `version`, keeping the outgoing one as the target. */
export function withActivatedVersion(
  record: OrcadActivationRecord,
  version: string,
  snapshot: OrcadStateSnapshot | null,
  now: Date,
  appVersion?: string
): OrcadActivationRecord {
  const same = record.active === version
  // A stopped record keeps activeAppVersion with nothing active; it names no `previous` here.
  const previousAppVersion = same
    ? record.previousAppVersion
    : record.active
      ? record.activeAppVersion
      : undefined
  return {
    schemaVersion: ORCAD_ACTIVATION_SCHEMA_VERSION,
    active: version,
    // Why keep the OLD previous when re-activating the same version: a repeated deploy of
    // an already-active build is not a version change, so it must not erase the rollback
    // target by naming the active version as its own predecessor.
    previous: same ? record.previous : record.active,
    activatedAt: now.toISOString(),
    snapshot: same ? record.snapshot : snapshot,
    ...(appVersion ? { activeAppVersion: appVersion } : {}),
    ...(previousAppVersion ? { previousAppVersion } : {})
  }
}

/** The record that results from rolling `active` back to `previous`. */
export function withRolledBackVersion(
  record: OrcadActivationRecord,
  now: Date
): OrcadActivationRecord {
  return {
    schemaVersion: ORCAD_ACTIVATION_SCHEMA_VERSION,
    active: record.previous,
    // Why null and not the version we just left: it is the build we are rolling back FROM,
    // so offering it as the next rollback target would walk straight back into the failure.
    previous: null,
    activatedAt: now.toISOString(),
    // The snapshot was taken before `active` ran; once restored it has been consumed.
    snapshot: null,
    ...(record.previousAppVersion ? { activeAppVersion: record.previousAppVersion } : {}),
    ...(record.active ? { rolledBackFrom: record.active } : {})
  }
}

/** The record after decommissioning `active`: nothing serves; the stopped build stays pinned. */
export function withDeactivatedVersion(record: OrcadActivationRecord): OrcadActivationRecord {
  return {
    schemaVersion: ORCAD_ACTIVATION_SCHEMA_VERSION,
    active: null,
    // Kept so GC leaves the slot whose daemon may still own terminals, and a redeploy can find it.
    previous: record.active,
    activatedAt: null,
    // No version is active, so there is nothing a pre-activation snapshot could roll back to.
    snapshot: null
  }
}

/**
 * The deactivated record as committed to the host. Never journaled: released peers require a stop
 * journal's `recordAfter` to equal their core-only `withDeactivatedVersion`, byte for byte.
 */
export function withDeactivatedVersionCommitted(
  record: OrcadActivationRecord
): OrcadActivationRecord {
  return {
    ...withDeactivatedVersion(record),
    // Why kept with nothing active: the stopped build may have migrated the host's state, and
    // released planners already skip a host whose activeAppVersion is newer than theirs.
    ...(record.activeAppVersion ? { activeAppVersion: record.activeAppVersion } : {}),
    ...(record.rolledBackFrom ? { rolledBackFrom: record.rolledBackFrom } : {})
  }
}

/**
 * Version dirs GC must not remove, as directory names.
 *
 * `previous` is here because a rollback target that GC deleted is not a rollback target.
 * `daemonEntryVersion` is here because an update preserves a live daemon forked from the
 * OUTGOING bundle (see orcad-update-plan.ts) — deleting the tree under a running process is
 * how a later respawn finds no entry point.
 */
export function orcadGcPinnedDirNames(
  record: OrcadActivationRecord,
  daemonEntryVersion?: string | null
): string[] {
  return orcadInstallDirNames([record.active, record.previous, daemonEntryVersion])
}

/** Distinct install dir names for the non-empty versions, in first-seen order. */
export function orcadInstallDirNames(versions: readonly (string | null | undefined)[]): string[] {
  const named = versions.filter((v): v is string => typeof v === 'string' && v.length > 0)
  return [...new Set(named)].map((version) => remoteInstallDirName(ORCAD_INSTALL_MODEL, version))
}
