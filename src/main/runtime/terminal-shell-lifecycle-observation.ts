import type { RuntimeTerminalSummary } from '../../shared/runtime-terminal-contracts'
import type { RuntimeTerminalShellLifecycle } from '../../shared/terminal-shell-lifecycle'
import type { PtyProcessInspection } from '../providers/pty-process-inspection'

export function terminalShellLifecycleObservation(
  summary: RuntimeTerminalSummary,
  runtimeId: string,
  inspection: PtyProcessInspection | null,
  failure = 'old-host',
  transportAgeMs = 0
): RuntimeTerminalShellLifecycle {
  const unknown: RuntimeTerminalShellLifecycle = {
    phase: 'unknown',
    confidence: 'none',
    source: 'none',
    reason: failure,
    generation: null,
    signalAgeMs: null,
    runtimeId,
    executionHostId: summary.executionHostId ?? null,
    ptyId: summary.ptyId,
    incarnationId: summary.incarnationId ?? null,
    authorityGeneration: null,
    observedAt: Date.now()
  }
  if (!summary.connected) {
    return { ...unknown, reason: 'disconnected' }
  }
  if (!summary.ptyId || !summary.incarnationId || !summary.executionHostId) {
    return { ...unknown, reason: 'incomplete-identity' }
  }
  if (!inspection) {
    return unknown
  }
  if (inspection.verdict === 'unverifiable') {
    return { ...unknown, reason: inspection.reason }
  }
  const signal = inspection.shellLifecycle
  if (!signal) {
    return unknown
  }
  if (signal.ptyIncarnationId !== summary.incarnationId) {
    return { ...unknown, reason: 'incarnation-mismatch' }
  }
  if (
    !signal.authorityGeneration ||
    !Number.isSafeInteger(signal.generation) ||
    signal.generation === null ||
    signal.generation < 0
  ) {
    return { ...unknown, reason: 'invalid-evidence' }
  }
  const age = signal.signalAgeMs === null ? null : signal.signalAgeMs + transportAgeMs
  const reason =
    age !== null && (!Number.isFinite(age) || age < 0 || age > 30_000)
      ? 'stale'
      : signal.phase !== 'unknown' && signal.signalAgeMs === null
        ? 'missing-signal'
        : signal.phase === 'prompt' && inspection.childProcessEvidence !== 'no-children'
          ? (inspection.childProcessEvidence ?? 'unverifiable')
          : signal.reason
  const phase =
    signal.source === 'managed-bash' &&
    signal.confidence === 'cooperative' &&
    reason === signal.reason &&
    ((signal.phase === 'prompt' && reason === 'managed-bash-prompt') ||
      (signal.phase === 'running' && reason === 'managed-bash-command'))
      ? signal.phase
      : 'unknown'
  return {
    ...unknown,
    phase,
    reason,
    source: signal.source,
    confidence: phase === 'unknown' ? 'none' : 'cooperative',
    generation: signal.generation,
    signalAgeMs: age,
    authorityGeneration: signal.authorityGeneration
  }
}
