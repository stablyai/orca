import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { durableWriteTempPath, writeFileDurableSync } from '../durable-file-write'
import type { ManagedHookInstallationMarker } from '../agent-hooks/managed-hook-install-policy'
import {
  getOrcaProfileIndexPath,
  getOrcaProfilesDirectory,
  LEGACY_BACKUP_COUNT,
  legacyBackupPath,
  legacyDataFilePath
} from '../orca-profiles/profile-storage-paths'

/**
 * Installation-scoped record of which hook cohort this copy of Orca belongs to. Lives at the
 * user-data root, outside every profile, because managed hooks are user-global: a second profile
 * must inherit the answer, never mint its own.
 *
 * Every ambiguity here resolves to `pre-change`, which installs exactly as Orca always has. Absent,
 * unreadable, malformed, partially written, or a failed establishment all mean "an installation we
 * cannot prove is new", and stopping hook maintenance for someone who already has hooks is the one
 * unrecoverable outcome.
 */
export const MANAGED_HOOK_INSTALLATION_MARKER_FILE = 'managed-hook-installation.json'

export type {
  ManagedHookInstallCohort,
  ManagedHookInstallationMarker,
  ManagedHookOnboardingDecision
} from '../agent-hooks/managed-hook-install-policy'

/** `passed` rather than `pending` so even a policy that skipped the cohort branch still allows. */
export const PRE_CHANGE_MANAGED_HOOK_MARKER: ManagedHookInstallationMarker = Object.freeze({
  installCohort: 'pre-change',
  onboardingDecision: 'passed'
})

const FRESH_INSTALL_MANAGED_HOOK_MARKER: ManagedHookInstallationMarker = Object.freeze({
  installCohort: 'post-change',
  onboardingDecision: 'pending'
})

export function managedHookInstallationMarkerPath(userDataPath: string): string {
  return join(userDataPath, MANAGED_HOOK_INSTALLATION_MARKER_FILE)
}

/**
 * Strict by design: both fields must be known literals. A half-written `{"installCohort":
 * "post-change"}` is malformed, and malformed reads as absent — reading it as pending would turn a
 * torn write into a deferral.
 */
export function parseManagedHookInstallationMarker(
  raw: string
): ManagedHookInstallationMarker | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null
  }
  const { installCohort, onboardingDecision } = parsed as Record<string, unknown>
  if (installCohort !== 'pre-change' && installCohort !== 'post-change') {
    return null
  }
  if (onboardingDecision !== 'pending' && onboardingDecision !== 'passed') {
    return null
  }
  return { installCohort, onboardingDecision }
}

export type ManagedHookInstallationMarkerHost = {
  readMarker: () => ManagedHookInstallationMarker | null
  /** Whether this user-data root already holds Orca state, i.e. Orca ran here before this change. */
  hasExistingInstallationState: () => boolean
  /** Returns whether the record actually landed; a failed write must not be treated as recorded. */
  writeMarker: (marker: ManagedHookInstallationMarker) => boolean
}

/**
 * Resolve the marker for this launch, minting one only for an installation with nothing of Orca's
 * in it yet. An upgrade persists nothing at all, so a later rollback sees the disk it left behind.
 */
export function resolveManagedHookInstallationMarker(
  host: ManagedHookInstallationMarkerHost
): ManagedHookInstallationMarker {
  const existing = host.readMarker()
  if (existing) {
    return existing
  }
  if (host.hasExistingInstallationState()) {
    return PRE_CHANGE_MANAGED_HOOK_MARKER
  }
  return host.writeMarker(FRESH_INSTALL_MANAGED_HOOK_MARKER)
    ? FRESH_INSTALL_MANAGED_HOOK_MARKER
    : PRE_CHANGE_MANAGED_HOOK_MARKER
}

/**
 * The closed set of artifacts a used Orca leaves at its user-data root. Any of them — or any error
 * reading for them — means "existing installation".
 */
export function hasExistingOrcaInstallationState(userDataPath: string): boolean {
  try {
    const candidates = [
      getOrcaProfileIndexPath(userDataPath),
      `${getOrcaProfileIndexPath(userDataPath)}.bak`,
      getOrcaProfilesDirectory(userDataPath),
      legacyDataFilePath(userDataPath),
      ...Array.from({ length: LEGACY_BACKUP_COUNT }, (_, index) =>
        legacyBackupPath(userDataPath, index)
      )
    ]
    return candidates.some((path) => existsSync(path))
  } catch {
    // Unreadable root: treat as existing so an I/O fault can never mint a deferral.
    return true
  }
}

function readMarkerFile(userDataPath: string): ManagedHookInstallationMarker | null {
  try {
    return parseManagedHookInstallationMarker(
      readFileSync(managedHookInstallationMarkerPath(userDataPath), 'utf-8')
    )
  } catch {
    return null
  }
}

function writeMarkerFile(userDataPath: string, marker: ManagedHookInstallationMarker): boolean {
  const path = managedHookInstallationMarkerPath(userDataPath)
  try {
    // Why: this runs before `ready`, so Electron has not necessarily created userData yet.
    mkdirSync(userDataPath, { recursive: true })
    writeFileDurableSync(durableWriteTempPath(path), path, `${JSON.stringify(marker, null, 2)}\n`)
    return true
  } catch (error) {
    console.warn('[managed-hooks] could not record the installation marker:', error)
    return false
  }
}

let establishedMarker: ManagedHookInstallationMarker | null = null

/** Bootstrap seam. Idempotent within a launch; the on-disk record is written at most once ever. */
export function establishManagedHookInstallationMarker(
  userDataPath: string
): ManagedHookInstallationMarker {
  establishedMarker = resolveManagedHookInstallationMarker({
    readMarker: () => readMarkerFile(userDataPath),
    hasExistingInstallationState: () => hasExistingOrcaInstallationState(userDataPath),
    writeMarker: (marker) => writeMarkerFile(userDataPath, marker)
  })
  return establishedMarker
}

/** Pre-change until bootstrap says otherwise: a host that never establishes one installs as today. */
export function getEstablishedManagedHookInstallationMarker(): ManagedHookInstallationMarker {
  return establishedMarker ?? PRE_CHANGE_MANAGED_HOOK_MARKER
}

/**
 * Whether this installation still owes an answer to the first-run question. Deliberately not the
 * policy decision: an unchecked box makes that `deny`, and keying the transition on it would leave
 * the marker pending forever, so re-enabling later in Settings would never install.
 */
export function isManagedHookOnboardingPending(): boolean {
  const marker = getEstablishedManagedHookInstallationMarker()
  return marker.installCohort === 'post-change' && marker.onboardingDecision === 'pending'
}

/**
 * Mark the onboarding question answered. Returns whether the installation is now recorded as
 * passed; a caller must stay pending on `false`, or a crash could install against an unchecked box.
 */
export function recordManagedHookOnboardingPassed(userDataPath: string): boolean {
  const current = readMarkerFile(userDataPath) ?? PRE_CHANGE_MANAGED_HOOK_MARKER
  if (current.installCohort === 'pre-change' || current.onboardingDecision === 'passed') {
    return true
  }
  const next: ManagedHookInstallationMarker = {
    installCohort: 'post-change',
    onboardingDecision: 'passed'
  }
  if (!writeMarkerFile(userDataPath, next)) {
    return false
  }
  establishedMarker = next
  return true
}

/** Test seam: drop the process-wide cache between cases. */
export function resetEstablishedManagedHookInstallationMarkerForTests(): void {
  establishedMarker = null
}
