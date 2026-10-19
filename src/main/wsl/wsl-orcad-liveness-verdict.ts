/**
 * Liveness of a WSL distro's orcad (design D2c), in the execution-host vocabulary.
 *
 * Why WSL can prove exits when SSH cannot: an SSH host that stops answering may still be running
 * everything, so loss of contact is never death. A WSL distro runs on this machine, and
 * `wsl --list --running` is a positive answer from the local WSL service, not silence: a distro it
 * confirms stopped has no processes left, and a distro whose `(boot id, pid 1 start ticks)`
 * changed was restarted, which ends every process of the old incarnation. Only those two answers
 * mark terminals `exited`. A probe that failed, timed out or could not be read is `unverifiable`.
 *
 * Exit codes are triggers and corroboration, never proof: `wsl.exe` exits 1 both when its distro
 * stops (measured ~40 ms after `wsl --terminate`) and when the WSL service hiccups, and a bridge
 * exits 0 whenever orcad closes its socket.
 */

export type WslLivenessTrigger =
  /** The held watch bridge or the holder `wsl.exe` exited with this code. */
  | { source: 'bridge' | 'holder'; code: number | null }
  /** A heartbeat, a power resume, or a retry: nothing exited, so re-check everything. */
  | { source: 'verify' }

export type WslLivenessEvidence = {
  trigger: WslLivenessTrigger
  /** A fresh `wsl --list --running` read; never a cached or fail-closed list. */
  running: { status: 'confirmed'; running: boolean } | { status: 'unavailable' }
  /** Absent unless the distro was confirmed running; null when the guest could not answer. */
  identity?: { distroInstance: string; orcad: string | null } | null
  /** What the connection recorded when it last reached ready. */
  expected: { distroInstance: string | null; orcad: string | null }
  /** A fresh bridge to orcad's port, opened only when process identity cannot decide. */
  orcadPort?: 'ready' | 'refused' | 'unverifiable'
}

export type WslLivenessVerdict =
  /** Confirmed stopped: every terminal and process in it is `exited`. */
  | { kind: 'distro-stopped'; corroborated: boolean }
  /** Running, but a new incarnation: every process of the old one is `exited`. */
  | { kind: 'distro-restarted' }
  /** Distro running, orcad gone: relaunch, then let the census decide about terminals. */
  | { kind: 'orcad-exited' }
  | { kind: 'live' }
  | { kind: 'unverifiable'; reason: WslLivenessUnverifiableReason }

export type WslLivenessUnverifiableReason =
  | 'running-list-unavailable'
  | 'guest-unanswered'
  | 'orcad-unanswered'

/** What the classifier still needs before it can decide; the supervisor gathers it in order. */
export type WslLivenessNextProbe = 'identity' | 'orcad-port' | null

export function nextWslLivenessProbe(evidence: WslLivenessEvidence): WslLivenessNextProbe {
  if (evidence.running.status !== 'confirmed' || !evidence.running.running) {
    return null
  }
  if (evidence.identity === undefined) {
    return 'identity'
  }
  const { identity, expected } = evidence
  if (identity === null) {
    return null
  }
  if (expected.distroInstance !== null && identity.distroInstance !== expected.distroInstance) {
    return null
  }
  if (expected.orcad !== null) {
    return null
  }
  return evidence.orcadPort === undefined ? 'orcad-port' : null
}

export function classifyWslOrcadLiveness(evidence: WslLivenessEvidence): WslLivenessVerdict {
  const { running, trigger, expected } = evidence
  if (running.status !== 'confirmed') {
    return { kind: 'unverifiable', reason: 'running-list-unavailable' }
  }
  if (!running.running) {
    return {
      kind: 'distro-stopped',
      corroborated: trigger.source !== 'verify' && trigger.code !== null && trigger.code !== 0
    }
  }
  const identity = evidence.identity
  if (!identity) {
    return { kind: 'unverifiable', reason: 'guest-unanswered' }
  }
  if (expected.distroInstance !== null && identity.distroInstance !== expected.distroInstance) {
    return { kind: 'distro-restarted' }
  }
  if (expected.orcad !== null) {
    // Same pid and same start ticks in the same incarnation is the same process.
    return identity.orcad === expected.orcad ? { kind: 'live' } : { kind: 'orcad-exited' }
  }
  // No process identity to compare (no pid file): orcad's own port has to answer.
  if (evidence.orcadPort === 'ready') {
    return { kind: 'live' }
  }
  if (evidence.orcadPort === 'refused') {
    return { kind: 'orcad-exited' }
  }
  return { kind: 'unverifiable', reason: 'orcad-unanswered' }
}

/** A terminal-level verdict a distro-level verdict proves; null leaves it to orcad's census. */
export function terminalVerdictOf(verdict: WslLivenessVerdict): 'exited' | 'unverifiable' | null {
  switch (verdict.kind) {
    case 'distro-stopped':
    case 'distro-restarted':
      return 'exited'
    case 'unverifiable':
      return 'unverifiable'
    case 'live':
    case 'orcad-exited':
      return null
  }
}
