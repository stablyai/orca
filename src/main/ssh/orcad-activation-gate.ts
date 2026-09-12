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
import { parsePairingCode } from '../../shared/pairing'
import { classifyRemotePairingHostname } from '../../shared/remote-pairing-address'
import type { OrcadBunTarget } from '../../shared/orcad-bun-runtime'

export type OrcadActivationRejectCode =
  | 'orcad_activation_no_readiness'
  | 'orcad_activation_no_health'
  | 'orcad_activation_build_mismatch'
  | 'orcad_activation_build_target_mismatch'
  | 'orcad_activation_not_listening'
  | 'orcad_activation_pairing_unavailable'
  | 'orcad_activation_pairing_invalid'
  | 'orcad_activation_runtime_mismatch'
  | 'orcad_activation_pty_backend_mismatch'
  | 'orcad_activation_daemon_runtime_mismatch'
  | 'orcad_activation_daemon_pty_backend_mismatch'
  | 'orcad_activation_daemon_absent'
  | 'orcad_activation_daemon_degraded'
  | 'orcad_activation_pty_self_test_failed'
  | 'orcad_activation_pty_self_test_insufficient'
  | 'orcad_activation_no_persistent_terminals'

export type OrcadActivationVerdict =
  | {
      decision: 'activate'
      /**
       * `pty-spawn` means a real PTY was created and torn down inside the daemon.
       * `handshake` means the daemon answered but did not prove a PTY spawn. Retained for
       * mixed-version payloads; activation rejects this weaker coverage.
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
  /** Runtime that the selected immutable slot is expected to launch. */
  runtimeKind: 'bun' | 'node'
  /** Native slot selected after probing the execution host. */
  buildTarget?: OrcadBunTarget
  /** Remote port the managed SSH tunnel is pinned to. */
  port: number
  /** Require runtime/backend proof from the terminal daemon itself. */
  requireDaemonRuntimeIdentity?: boolean
}

function isLoopbackWebSocketEndpoint(value: string): boolean {
  try {
    const endpoint = new URL(value)
    return (
      (endpoint.protocol === 'ws:' || endpoint.protocol === 'wss:') &&
      classifyRemotePairingHostname(endpoint.hostname) === 'loopback'
    )
  } catch {
    return false
  }
}

function endpointPort(value: string): number | null {
  try {
    const endpoint = new URL(value)
    const port = endpoint.port || (endpoint.protocol === 'wss:' ? '443' : '80')
    const parsed = Number.parseInt(port, 10)
    return Number.isInteger(parsed) ? parsed : null
  } catch {
    return null
  }
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
  if (expected.buildTarget) {
    const [platform, arch, libc] = expected.buildTarget.split('-')
    if (
      health.buildTarget !== expected.buildTarget ||
      health.platform !== platform ||
      health.arch !== arch ||
      (platform === 'linux' && health.libc !== libc)
    ) {
      return {
        decision: 'reject',
        code: 'orcad_activation_build_target_mismatch',
        reason:
          `The candidate reports target ${health.buildTarget ?? 'unknown'} on ` +
          `${health.platform}-${health.arch}${health.libc ? `-${health.libc}` : ''}, not the ` +
          `${expected.buildTarget} slot selected for this host. Nothing was activated.`
      }
    }
  }
  if (
    !readiness.boundEndpoint ||
    !isLoopbackWebSocketEndpoint(readiness.boundEndpoint) ||
    endpointPort(readiness.boundEndpoint) !== expected.port
  ) {
    return {
      decision: 'reject',
      code: 'orcad_activation_not_listening',
      reason:
        'The candidate did not report a loopback WebSocket endpoint, so the managed SSH ' +
        'tunnel cannot reach it without widening network exposure. Nothing was activated.'
    }
  }
  if (!readiness.pairing.available) {
    return {
      decision: 'reject',
      code: 'orcad_activation_pairing_unavailable',
      reason:
        `The candidate did not publish a managed-runtime pairing offer ` +
        `(${readiness.pairing.reason}). Without credentials the client cannot link the ` +
        'server after activation. Nothing was activated.'
    }
  }
  const pairingOffer = parsePairingCode(readiness.pairing.url)
  if (
    !pairingOffer ||
    pairingOffer.scope !== 'runtime' ||
    pairingOffer.pairedDeviceId !== readiness.pairing.deviceId ||
    readiness.pairing.scope !== 'runtime' ||
    !isLoopbackWebSocketEndpoint(pairingOffer.endpoint) ||
    !isLoopbackWebSocketEndpoint(readiness.pairing.endpoint) ||
    endpointPort(pairingOffer.endpoint) !== expected.port ||
    endpointPort(readiness.pairing.endpoint) !== expected.port ||
    new URL(pairingOffer.endpoint).toString() !== new URL(readiness.pairing.endpoint).toString()
  ) {
    return {
      decision: 'reject',
      code: 'orcad_activation_pairing_invalid',
      reason:
        'The candidate published an invalid or inconsistent managed-runtime pairing offer. ' +
        'The client could not safely create its tunneled credential. Nothing was activated.'
    }
  }
  if (health.runtimeKind !== expected.runtimeKind) {
    return {
      decision: 'reject',
      code: 'orcad_activation_runtime_mismatch',
      reason:
        `The candidate is running under ${health.runtimeKind ?? 'an unidentified runtime'}, ` +
        `not the expected ${expected.runtimeKind}. Nothing was activated.`
    }
  }
  const expectedPtyBackend = expected.runtimeKind === 'bun' ? 'bun-terminal' : 'node-pty'
  if (health.ptyBackend !== expectedPtyBackend) {
    return {
      decision: 'reject',
      code: 'orcad_activation_pty_backend_mismatch',
      reason:
        `The candidate reports PTY backend ${health.ptyBackend ?? 'unknown'}, not ` +
        `${expectedPtyBackend}. Nothing was activated.`
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
  if (expected.requireDaemonRuntimeIdentity) {
    if (daemon.runtimeKind !== expected.runtimeKind) {
      return {
        decision: 'reject',
        code: 'orcad_activation_daemon_runtime_mismatch',
        reason:
          `The terminal daemon is running under ${daemon.runtimeKind ?? 'an unidentified runtime'}, ` +
          `not the expected ${expected.runtimeKind}. Nothing was activated.`
      }
    }
    const expectedDaemonBackend = expected.runtimeKind === 'bun' ? 'bun-terminal' : 'node-pty'
    if (daemon.ptyBackend !== expectedDaemonBackend) {
      return {
        decision: 'reject',
        code: 'orcad_activation_daemon_pty_backend_mismatch',
        reason:
          `The terminal daemon reports PTY backend ${daemon.ptyBackend ?? 'unknown'}, not ` +
          `${expectedDaemonBackend}. Nothing was activated.`
      }
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
  if (daemon.selfTest.coverage !== 'pty-spawn') {
    return {
      decision: 'reject',
      code: 'orcad_activation_pty_self_test_insufficient',
      reason:
        "The candidate's daemon answered its health handshake but did not prove a real PTY " +
        'spawn and exit on this host. Nothing was activated.'
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
