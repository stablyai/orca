/**
 * Whether a freshly launched orcad has earned the right to become the active one.
 *
 * The failure this exists to prevent is the one `docs/design/shipping-orcad.html` names
 * throughout: a deployment that reports success because a port opened. orcad answers RPC
 * from its own process, so "listening" stays true while the terminal daemon that owns every
 * terminal is dead — a green host that cannot run a single command. Activation therefore
 * reads the cross-process health payload the candidate published, not the exit code of the
 * command that started it.
 *
 * A refusal here is not a failure to deploy. The bytes are installed and the previous
 * version is still active; nothing was lost. Activating on a bad verdict is what loses
 * things.
 */
import type { ServeReadiness } from '../server/serve-readiness'

export type OrcadActivationRejectCode =
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
      /**
       * `pty-spawn` means a real PTY was created and torn down inside the daemon.
       * `handshake` means the daemon answered but its spawn probe is a no-op on this
       * platform (win32). Carried through so an activation is never recorded as proving
       * more than it did.
       */
      coverage: 'pty-spawn' | 'handshake'
      warnings: string[]
    }
  | { decision: 'reject'; code: OrcadActivationRejectCode; reason: string }

export type OrcadActivationExpectation = {
  /** sha256(orcad.js).slice(0,16) computed from the bytes this client just uploaded. */
  buildHash: string
  /** The full content-hashed version this deploy installed. */
  fullVersion: string
}

/**
 * Gate an activation on what the candidate actually reported.
 *
 * Order matters: identity before health. A health payload from the wrong process is worse
 * than no payload, because it is green and about something else.
 */
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
  // Why identity first: a stale orcad already holding the port would answer readiness and
  // report its own (healthy) daemon. Activating on that record points the pointer at bytes
  // nobody is running.
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
        'prevent. Nothing was activated.'
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
    // Not a rejection: the hash already proved identity, and ORCA_VERSION is whatever the
    // launch command exported. Worth saying, because a mismatch means the launch env is wrong.
    warnings.push(
      `The candidate reports version ${health.buildVersion} but was installed as ` +
        `${expected.fullVersion}; check ORCA_VERSION in the launch command.`
    )
  }
  return { decision: 'activate', coverage: daemon.selfTest.coverage, warnings }
}
