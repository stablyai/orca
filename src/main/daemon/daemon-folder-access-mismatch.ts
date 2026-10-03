// Evidence behind the macOS folder-access notice (STA-7948). Main-process only, at most one entry,
// keyed by the daemon that produced it: a restart mints a new identity, so the next read returns
// null and the notice clears without probing anything.

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

/** Long enough that a focus-time poll cannot spin up a child per poll, short enough to feel live. */
const PROBE_REFRESH_INTERVAL_MS = 5_000

/** What a daemon forked by this app right now would get, or `unknown` if the probe could not say. */
export type FreshDaemonAccess = 'allowed' | 'denied' | 'unknown'

/** What the renderer is allowed to see: an opaque per-daemon scope, the folder class, a verdict. */
export type DaemonFolderAccessMismatchNotice = {
  daemonScope: string
  cwdClass: DaemonPtyCwdClass
  freshDaemonAccess: FreshDaemonAccess
}

type StoredMismatch = DaemonFolderAccessMismatchNotice & {
  daemonKey: string
  canonicalPath: string
  probedAtMs: number | null
  /** Latched once this denial has served as a restart's before-picture, so it counts one outcome. */
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
    // Telemetry is best-effort; a dropped event must never withhold or delay the notice.
  }
}

function daemonKeyOf(identity: DaemonEndpointIdentity): string {
  return `${identity.pid}:${identity.startedAtMs}:${identity.launchNonce}`
}

/**
 * Digest, never a path. The folder class is in it because the notice names a folder: one daemon
 * denied a second class is a different remedy, and must not inherit the first one's latches.
 */
function daemonScopeOf(daemonKey: string, cwdClass: DaemonPtyCwdClass): string {
  return createHash('sha256').update(`${daemonKey}:${cwdClass}`).digest('hex').slice(0, 16)
}

/** The entry, but only while it still belongs to the daemon asking for it. */
function entryFor(identity: DaemonEndpointIdentity | null): StoredMismatch | null {
  if (!identity || !stored || stored.daemonKey !== daemonKeyOf(identity)) {
    return null
  }
  return stored
}

/** Only `ok` proves a fresh daemon would get in; a non-verdict stays `unknown`, never `denied`. */
function freshDaemonAccessFrom(outcome: FreshDaemonFolderAccess): FreshDaemonAccess {
  if (outcome === 'ok') {
    return 'allowed'
  }
  return outcome === 'denied' ? 'denied' : 'unknown'
}

async function probeStoredEntry(entry: StoredMismatch): Promise<void> {
  const outcome = await probeFolderAccessForFreshDaemon(entry.canonicalPath)
  // Why the identity compare: a later spawn may have replaced the entry while the child ran.
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

/**
 * The restart's verdict: the first spawn by a *different* daemon into the folder class the stored
 * denial is about. An entry the same daemon already read back is gone, so it reports nothing.
 */
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
  // Why no probe here: this is the PTY spawn path, and the focus-time poll probes before it answers.
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

/**
 * A later spawn this daemon could read retires its own evidence, but only for the same folder
 * class: TCC denies Documents as a whole, so a readable `~/code` says nothing about it.
 */
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

/**
 * Re-runs the probe so step 1 of the fix dialog can complete itself: the user allows Orca in System
 * Settings, returns to the app, and the focus-time poll is the only thing that can notice. A
 * settled `allowed` is final, and a probe younger than the interval is reused.
 */
export async function refreshDaemonFolderAccessProbe(
  identity: DaemonEndpointIdentity | null,
  options?: { force?: boolean }
): Promise<void> {
  const force = options?.force === true
  // A probe started before the remedy ran cannot see its effect, and its late write would be
  // discarded anyway; let it land, then probe whatever entry it leaves behind.
  if (force && probeInFlight) {
    await probeInFlight
  }
  const entry = entryFor(identity)
  // Why force skips the settled shortcut: a reset must be judged by a probe that ran after it.
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

/**
 * The folder the stored evidence is about, for remedies that must act on it. Deliberately narrow:
 * the canonical path is the one field the notice itself must never carry off the main process.
 */
export function getDaemonFolderAccessTarget(
  identity: DaemonEndpointIdentity | null
): { canonicalPath: string; cwdClass: DaemonPtyCwdClass } | null {
  const entry = entryFor(identity)
  return entry ? { canonicalPath: entry.canonicalPath, cwdClass: entry.cwdClass } : null
}

/** Returns evidence only while it still belongs to the daemon in use. */
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
