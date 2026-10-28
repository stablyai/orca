// Scope the single main-process denial record to its daemon; replacement clears the notice.

import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import {
  classifyDaemonPtyCwd,
  type DaemonPtyCwdClass
} from '../../shared/daemon-adoption-telemetry'
import type { EventProps } from '../../shared/telemetry-events'
import { track } from '../telemetry/client'
import {
  probeFolderAccessForFreshDaemon,
  type FreshDaemonFolderAccess
} from './daemon-folder-access-probe'
import type { DaemonEndpointIdentity } from './daemon-hello-protocol'

// Throttle child probes during focus-time polling.
const PROBE_REFRESH_INTERVAL_MS = 5_000

/** A fresh child of the current app may inherit different TCC access from the running daemon. */
export type FreshDaemonAccess = 'allowed' | 'denied' | 'unknown'

/** Renderer notices omit the canonical folder path. */
export type DaemonFolderAccessMismatchNotice = {
  daemonScope: string
  cwdClass: DaemonPtyCwdClass
  freshDaemonAccess: FreshDaemonAccess
}

type StoredMismatch = DaemonFolderAccessMismatchNotice & {
  daemonKey: string
  canonicalPath: string
  probedAtMs: number | null
  /** Count at most one restart outcome per denial. */
  outcomeReported: boolean
}

let stored: StoredMismatch | null = null
let probeInFlight: Promise<void> | null = null

function emit(
  action: EventProps<'daemon_folder_access_notice'>['action'],
  cwdClass: DaemonPtyCwdClass
): void {
  try {
    track('daemon_folder_access_notice', { action, cwd_class: cwdClass })
  } catch {
    // Telemetry failure must not suppress the notice.
  }
}

function daemonKeyOf(identity: DaemonEndpointIdentity): string {
  return `${identity.pid}:${identity.startedAtMs}:${identity.launchNonce}`
}

/** Hash daemon identity and folder class so each remedy gets independent latches without exposing paths. */
function daemonScopeOf(daemonKey: string, cwdClass: DaemonPtyCwdClass): string {
  return createHash('sha256').update(`${daemonKey}:${cwdClass}`).digest('hex').slice(0, 16)
}

function entryFor(identity: DaemonEndpointIdentity | null): StoredMismatch | null {
  if (!identity || !stored || stored.daemonKey !== daemonKeyOf(identity)) {
    return null
  }
  return stored
}

function freshDaemonAccessFrom(outcome: FreshDaemonFolderAccess): FreshDaemonAccess {
  if (outcome === 'ok') {
    return 'allowed'
  }
  return outcome === 'denied' ? 'denied' : 'unknown'
}

async function probeStoredEntry(entry: StoredMismatch): Promise<void> {
  const outcome = await probeFolderAccessForFreshDaemon(entry.canonicalPath)
  // Ignore a stale child result if a later spawn replaced the record.
  if (stored !== entry) {
    return
  }
  stored = { ...entry, freshDaemonAccess: freshDaemonAccessFrom(outcome), probedAtMs: Date.now() }
}

function startProbe(entry: StoredMismatch): Promise<void> {
  const run = probeStoredEntry(entry).catch(() => {})
  probeInFlight = run
  void run.then(() => {
    if (probeInFlight === run) {
      probeInFlight = null
    }
  })
  return run
}

/** Judge a restart from its first spawn in the denied folder class; prior same-daemon recovery clears evidence. */
function reportOutcomeIfReplacementDaemon(
  daemonKey: string,
  cwdClass: DaemonPtyCwdClass,
  fixed: boolean
): void {
  const prior = stored
  if (
    !prior ||
    prior.outcomeReported ||
    prior.daemonKey === daemonKey ||
    prior.cwdClass !== cwdClass
  ) {
    return
  }
  prior.outcomeReported = true
  emit(fixed ? 'restart_outcome_fixed' : 'restart_outcome_still_denied', cwdClass)
}

export function recordDaemonFolderAccessMismatch(
  identity: DaemonEndpointIdentity | null,
  cwd: string
): void {
  if (!identity) {
    return
  }
  const daemonKey = daemonKeyOf(identity)
  const cwdClass = classifyDaemonPtyCwd(cwd, homedir())
  reportOutcomeIfReplacementDaemon(daemonKey, cwdClass, false)
  // Keep child probes off the PTY spawn path; focus-time polling performs them.
  stored = {
    daemonKey,
    daemonScope: daemonScopeOf(daemonKey, cwdClass),
    cwdClass,
    canonicalPath: cwd,
    freshDaemonAccess: 'unknown',
    probedAtMs: null,
    outcomeReported: false
  }
}

/** Clear only the same folder class: a readable ~/code does not prove Documents access. */
export function clearDaemonFolderAccessMismatch(
  identity: DaemonEndpointIdentity | null,
  cwd: string
): void {
  if (!identity) {
    return
  }
  const cwdClass = classifyDaemonPtyCwd(cwd, homedir())
  reportOutcomeIfReplacementDaemon(daemonKeyOf(identity), cwdClass, true)
  if (entryFor(identity)?.cwdClass === cwdClass) {
    stored = null
  }
}

/** Focus-time polling notices new grants; force bypasses cached verdicts after a reset. */
export async function refreshDaemonFolderAccessProbe(
  identity: DaemonEndpointIdentity | null,
  options?: { force?: boolean }
): Promise<void> {
  const force = options?.force === true
  // Wait for the pre-reset probe to settle before starting one that can observe the remedy.
  if (force && probeInFlight) {
    await probeInFlight
  }
  const entry = entryFor(identity)
  if (!entry || (!force && entry.freshDaemonAccess === 'allowed')) {
    return
  }
  if (
    !force &&
    entry.probedAtMs !== null &&
    Date.now() - entry.probedAtMs < PROBE_REFRESH_INTERVAL_MS
  ) {
    return
  }
  await (force ? startProbe(entry) : (probeInFlight ?? startProbe(entry)))
}

/** Main-process remedies need the canonical path; renderer notices must never include it. */
export function getDaemonFolderAccessTarget(
  identity: DaemonEndpointIdentity | null
): { canonicalPath: string; cwdClass: DaemonPtyCwdClass } | null {
  const entry = entryFor(identity)
  return entry ? { canonicalPath: entry.canonicalPath, cwdClass: entry.cwdClass } : null
}

export function getDaemonFolderAccessMismatch(
  currentIdentity: DaemonEndpointIdentity | null
): DaemonFolderAccessMismatchNotice | null {
  const entry = entryFor(currentIdentity)
  if (!entry) {
    return null
  }
  return {
    daemonScope: entry.daemonScope,
    cwdClass: entry.cwdClass,
    freshDaemonAccess: entry.freshDaemonAccess
  }
}

export function resetDaemonFolderAccessMismatchForTests(): void {
  stored = null
  probeInFlight = null
}
