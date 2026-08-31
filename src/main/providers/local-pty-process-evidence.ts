import type {
  PtyChildProcessesEvidence,
  PtyForegroundProcessEvidence
} from '../../shared/pty-process-inspection-evidence'
import { isShellProcess } from '../../shared/shell-process-detection'

/** A local foreground read plus the evidence behind it. */
export type LocalForegroundObservation = {
  processName: string | null
  evidence: PtyForegroundProcessEvidence
}

export function classifyLocalForegroundEvidence(
  processName: string | null,
  available: boolean
): PtyForegroundProcessEvidence {
  if (!available) {
    return { verdict: 'unverifiable', reason: 'process table scan degraded' }
  }
  if (!processName || isShellProcess(processName)) {
    return { verdict: 'exited', processName }
  }
  return { verdict: 'live', processName }
}

type LocalPtyTitleRead = { ok: true; title: string | null } | { ok: false }

/** A native title read that throws is a failed probe, not an idle shell. */
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

/** Keep legacy booleans while retaining the three-valued child-process verdict. */
export function classifyLocalPtyChildProcesses(input: {
  procPresent: boolean
  titleRead: LocalPtyTitleRead
  shell: string | undefined
  foreground: PtyForegroundProcessEvidence
}): { hasChildProcesses: boolean; evidence: PtyChildProcessesEvidence } {
  if (!input.procPresent) {
    return { hasChildProcesses: false, evidence: { verdict: 'exited' } }
  }
  if (!input.titleRead.ok) {
    return {
      hasChildProcesses: false,
      evidence: { verdict: 'unverifiable', reason: 'pty title read failed' }
    }
  }
  if (!input.shell || input.titleRead.title !== input.shell) {
    return { hasChildProcesses: true, evidence: { verdict: 'live' } }
  }
  if (input.foreground.verdict === 'unverifiable') {
    return {
      hasChildProcesses: false,
      evidence: {
        verdict: 'unverifiable',
        reason: 'pty title matches the shell while the foreground scan is degraded'
      }
    }
  }
  if (input.foreground.verdict === 'live') {
    return { hasChildProcesses: false, evidence: { verdict: 'live' } }
  }
  return { hasChildProcesses: false, evidence: { verdict: 'exited' } }
}
