/** Proving that the orcad an activation record names is the one actually serving. */
import { evaluateOrcadActivation, type OrcadActivationExpectation } from './orcad-activation-gate'
import {
  orcadLivenessProbeCommand,
  parseOrcadLiveness,
  type OrcadLaunchSpec,
  type OrcadReadinessParse
} from './orcad-remote-launch'
import {
  execOrcadRemote,
  launchOrcadAndAwaitReadiness,
  type OrcadRemoteExecTarget
} from './orcad-remote-runtime-control'
import {
  parseOrcadReadinessWaitOutput,
  readOrcadReadinessNowCommand
} from './orcad-remote-readiness-wait'
import type { ServeReadiness } from '../server/serve-readiness'
import { withOrcadLogTail } from './orcad-remote-log-tail'

/** `exited` is proven absence; `unverifiable` means the host could not say, which is not death. */
export type OrcadReadinessFailureVerdict = 'exited' | 'unverifiable' | 'rejected'

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

/**
 * A slot proves terminals only when its daemon's self-test spawned a PTY, or completed the
 * handshake on a platform whose daemon never spawn-probes. A build that predates the coverage
 * field keeps the identity gate alone, so an older slot is not stranded.
 */
export function orcadDaemonCoverageRefusal(readiness: ServeReadiness): string | null {
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

/** Checks a recorded-active slot without starting anything. */
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

/** Starts a slot (recovery or rollback) and accepts it only if it proves the expected build. */
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
