// A listening orcad can have a dead terminal daemon; activation needs candidate identity and cross-process health.
import type { ServeReadiness } from '../../server/serve-readiness'

type OrcadActivationRejectCode =
  | 'orcad_activation_no_readiness'
  | 'orcad_activation_no_health'
  | 'orcad_activation_build_mismatch'
  | 'orcad_activation_not_listening'
  | 'orcad_activation_daemon_absent'
  | 'orcad_activation_daemon_degraded'
  | 'orcad_activation_pty_self_test_failed'
  | 'orcad_activation_no_persistent_terminals'

export type OrcadActivationVerdict =
  | {
      decision: 'activate'
      /** pty-spawn proves creation/teardown; handshake proves contact only, as on Windows. */
      coverage: 'pty-spawn' | 'handshake'
      warnings: string[]
    }
  | { decision: 'reject'; code: OrcadActivationRejectCode; reason: string }

export type OrcadActivationExpectation = {
  /** Entry bytes uploaded by this client, rather than a candidate's self-claimed version. */
  buildHash: string
  fullVersion: string
}

export function evaluateOrcadActivation(
  readiness: ServeReadiness | null,
  expected: OrcadActivationExpectation
): OrcadActivationVerdict {
  if (!readiness) {
    return {
      decision: 'reject',
      code: 'orcad_activation_no_readiness',
      reason:
        'The candidate orcad never published an `orca_server_ready` line. It may have exited, ' +
        'failed to bind, or be wedged before readiness. Nothing was activated.'
    }
  }
  const health = readiness.health
  if (!health) {
    return {
      decision: 'reject',
      code: 'orcad_activation_no_health',
      reason:
        'The candidate published readiness without a health payload, so its terminal daemon ' +
        'is unverified. Absence of a verdict is not a healthy verdict — treat this build as ' +
        'too old to gate on and do not activate it.'
    }
  }
  // Check identity before health: a healthy old process holding the port cannot vouch for the candidate.
  if (health.buildHash !== expected.buildHash) {
    return {
      decision: 'reject',
      code: 'orcad_activation_build_mismatch',
      reason:
        `The process that answered is running build ${health.buildHash}, not the ` +
        `${expected.buildHash} this deploy installed. Something else owns that port, or the ` +
        'upload did not land. Nothing was activated.'
    }
  }
  if (!readiness.boundEndpoint) {
    return {
      decision: 'reject',
      code: 'orcad_activation_not_listening',
      reason:
        'The candidate reported no bound endpoint, so no client could reach it. Nothing was ' +
        'activated.'
    }
  }
  const daemon = health.terminalDaemon
  if (daemon.state === 'absent') {
    return {
      decision: 'reject',
      code: 'orcad_activation_daemon_absent',
      reason:
        'The candidate has no terminal daemon. Every terminal on this host would run in the ' +
        'orcad process and die with it, which is the exact regression the daemon exists to ' +
        "prevent. Nothing was activated; orcad.log carries the daemon's startup error, and " +
        'the next connect retries.'
    }
  }
  if (daemon.state === 'degraded') {
    return {
      decision: 'reject',
      code: 'orcad_activation_daemon_degraded',
      reason:
        `The candidate's terminal daemon is degraded (self-test: ${daemon.selfTest.verdict}). ` +
        'Existing sessions keep working, but fresh terminals would not survive a restart. ' +
        'Nothing was activated; the previous version is still serving.'
    }
  }
  if (!daemon.selfTest.ok) {
    return {
      decision: 'reject',
      code: 'orcad_activation_pty_self_test_failed',
      reason:
        `The candidate's PTY self-test failed (${daemon.selfTest.verdict}). The host is ` +
        'listening but cannot create a terminal. Nothing was activated.'
    }
  }
  if (!daemon.ownsFreshSessions) {
    return {
      decision: 'reject',
      code: 'orcad_activation_no_persistent_terminals',
      reason:
        'The candidate answered healthy but does not own fresh sessions, so new terminals ' +
        'would not survive its own restart. Nothing was activated.'
    }
  }
  const warnings: string[] = []
  if (daemon.selfTest.coverage === 'handshake') {
    warnings.push(
      'The PTY self-test covered the daemon handshake only — this platform does not spawn a ' +
        'probe PTY. Terminal creation is unproven on this host.'
    )
  }
  if (health.buildVersion !== expected.fullVersion) {
    // Matching bytes already prove identity; version mismatch diagnoses launch environment without rejecting activation.
    warnings.push(
      `The candidate reports version ${health.buildVersion} but was installed as ` +
        `${expected.fullVersion}; check ORCA_VERSION in the launch command.`
    )
  }
  return { decision: 'activate', coverage: daemon.selfTest.coverage, warnings }
}
