import {
  evaluateOrcadActivation,
  type OrcadActivationExpectation
} from '../managed-server/activation/orcad-activation-gate'
import {
  orcadLivenessProbeCommand,
  parseOrcadLiveness,
  type OrcadLaunchSpec,
  type OrcadReadinessParse
} from '../managed-server/install/orcad-remote-launch'
import {
  execOrcadRemote,
  launchOrcadAndAwaitReadiness,
  type OrcadRemoteExecTarget
} from '../managed-server/install/orcad-remote-runtime-control'
import {
  parseOrcadReadinessWaitOutput,
  readOrcadReadinessNowCommand
} from '../managed-server/install/orcad-remote-readiness-wait'
import type { ServeReadiness } from '../server/serve-readiness'
import { withOrcadLogTail } from '../managed-server/install/orcad-remote-log-tail'

type OrcadReadinessFailureVerdict = 'exited' | 'unverifiable' | 'rejected'

export class OrcadActiveReadinessError extends Error {
  constructor(
    readonly verdict: OrcadReadinessFailureVerdict,
    message: string
  ) {
    super(message)
    this.name = 'OrcadActiveReadinessError'
  }
}

function gatedReadiness(
  parsed: OrcadReadinessParse,
  expectation: OrcadActivationExpectation,
  label: string
): ServeReadiness {
  const readiness = parsed.state === 'ready' ? parsed.readiness : null
  const verdict = evaluateOrcadActivation(readiness, expectation)
  if (verdict.decision === 'reject') {
    throw new OrcadActiveReadinessError(
      'rejected',
      `${label} failed its readiness check: ${verdict.reason}`
    )
  }
  if (!readiness) {
    throw new OrcadActiveReadinessError(
      'rejected',
      `${label} passed activation without a readiness payload.`
    )
  }
  const coverage = orcadDaemonCoverageRefusal(readiness)
  if (coverage) {
    throw new OrcadActiveReadinessError('rejected', `${label} ${coverage}`)
  }
  return readiness
}

/** Require PTY self-test coverage, or handshake on platforms that cannot spawn-probe. Older slots without coverage metadata retain the identity-only gate. */
function orcadDaemonCoverageRefusal(readiness: ServeReadiness): string | null {
  const health = readiness.health
  const coverage = health?.terminalDaemon?.selfTest?.coverage
  if (!health || coverage === undefined || coverage === 'pty-spawn') {
    return null
  }
  if (coverage === 'handshake' && health.platform === 'win32') {
    return null
  }
  return (
    `reported terminal-daemon coverage '${String(coverage)}', which does not prove a PTY can ` +
    `be created on ${health.platform}.`
  )
}

export async function probeActiveOrcadReadiness(
  target: OrcadRemoteExecTarget & { remoteInstallDir: string },
  expectation: OrcadActivationExpectation
): Promise<ServeReadiness> {
  const liveness = parseOrcadLiveness(
    await execOrcadRemote(target, orcadLivenessProbeCommand(target.host, target.remoteInstallDir))
  )
  if (liveness === 'DEAD') {
    throw new OrcadActiveReadinessError(
      'exited',
      `orcad ${expectation.fullVersion} is recorded active but its process has exited.`
    )
  }
  if (liveness === 'NEVER_LAUNCHED') {
    throw new OrcadActiveReadinessError(
      'exited',
      `orcad ${expectation.fullVersion} is recorded active but was never started from its install directory.`
    )
  }
  if (liveness !== 'LIVE') {
    throw new OrcadActiveReadinessError(
      'unverifiable',
      `orcad ${expectation.fullVersion} process state is unverifiable.`
    )
  }
  const parsed = parseOrcadReadinessWaitOutput(
    target.host,
    await execOrcadRemote(
      target,
      readOrcadReadinessNowCommand(target.host, target.remoteInstallDir)
    )
  )
  return gatedReadiness(parsed, expectation, 'The active orcad')
}

/** Accept recovery/rollback launches only when they prove the expected build. */
export async function launchOrcadSlotAndAwaitReadiness(
  target: OrcadRemoteExecTarget & {
    readinessTimeoutMs?: number
    sleep?: (ms: number) => Promise<void>
  },
  spec: OrcadLaunchSpec,
  expectation: OrcadActivationExpectation
): Promise<ServeReadiness> {
  const parsed = await launchOrcadAndAwaitReadiness(target, spec)
  try {
    return gatedReadiness(parsed, expectation, `orcad ${spec.fullVersion}`)
  } catch (error) {
    if (!(error instanceof OrcadActiveReadinessError)) {
      throw error
    }
    const message = await withOrcadLogTail(target, spec.remoteInstallDir, error.message)
    throw new OrcadActiveReadinessError(error.verdict, message)
  }
}
