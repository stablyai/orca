import type {
  PtyChildProcessesEvidence,
  PtyForegroundProcessEvidence
} from '../../shared/pty-process-inspection-evidence'

/** A local foreground read plus the evidence verdict behind it. The legacy
 *  `processName` keeps the exact pre-evidence collapse (stable-cache fallback
 *  included); the evidence says whether anything was actually observed. */
export type LocalForegroundObservation = {
  processName: string | null
  evidence: PtyForegroundProcessEvidence
}

type LocalPtyTitleRead = { ok: true; title: string | null } | { ok: false }

/** Read node-pty's foreground title without letting a native failure throw
 *  through the inspection. A thrown read is a failed probe, not "no children". */
export function readLocalPtyTitle(proc: { process: string } | undefined): LocalPtyTitleRead {
  if (!proc) {
    return { ok: false }
  }
  try {
    return { ok: true, title: proc.process || null }
  } catch {
    return { ok: false }
  }
}

/**
 * Classify the local child-process probe. The legacy boolean reproduces
 * LocalPtyProvider.hasChildProcesses exactly; the evidence keeps
 * live / unverifiable / exited distinct (docs/reference/ssh-execution-boundary.md).
 *
 * The load-bearing rule: a title that equals the shell is only exit evidence
 * when the foreground scan completed. node-pty's POSIX title read silently
 * falls back to the spawned shell name when the native read fails, so under
 * the same distress that degrades the scan, "title == shell" observes nothing.
 */
export function classifyLocalPtyChildProcesses(input: {
  procPresent: boolean
  titleRead: LocalPtyTitleRead
  shell: string | undefined
  foreground: PtyForegroundProcessEvidence
}): { hasChildProcesses: boolean; evidence: PtyChildProcessesEvidence } {
  if (!input.procPresent) {
    // The provider owns this table; a missing entry means the PTY was reaped.
    return { hasChildProcesses: false, evidence: { verdict: 'exited' } }
  }
  if (!input.titleRead.ok) {
    return {
      hasChildProcesses: false,
      evidence: { verdict: 'unverifiable', reason: 'pty title read failed' }
    }
  }
  if (!input.shell) {
    return { hasChildProcesses: true, evidence: { verdict: 'live' } }
  }
  if (input.titleRead.title !== input.shell) {
    return { hasChildProcesses: true, evidence: { verdict: 'live' } }
  }
  if (input.foreground.verdict !== 'observed') {
    return {
      hasChildProcesses: false,
      evidence: {
        verdict: 'unverifiable',
        reason: 'pty title matches the shell while the foreground scan is degraded'
      }
    }
  }

  if (input.foreground.processName && input.foreground.processName !== input.shell) {
    // The completed scan itself observed a live non-shell foreground process;
    // a stale shell title must not contradict it.
    return { hasChildProcesses: false, evidence: { verdict: 'live' } }
  }
  return { hasChildProcesses: false, evidence: { verdict: 'exited' } }
}
