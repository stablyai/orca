import { execCommand } from './ssh-relay-deploy-helpers'
import type { OrcadDeployOptions } from './orcad-remote-deploy'
import type { OrcadRollbackOptions } from './orcad-remote-rollback'
import type { ActiveRuntimeIdentity } from './orcad-rollback-recovery'
import {
  orcadLaunchCommand,
  parseOrcadReadinessOutput,
  readOrcadReadinessCommand,
  type OrcadLaunchSpec
} from './orcad-remote-launch'
import { resolveOrcadActivationReadinessTimeout } from './orcad-activation-lock'
import { evaluateOrcadActivation, type OrcadActivationVerdict } from './orcad-activation-gate'
import { parseOrcadStopOutcome, stopOrcadCommand } from './orcad-remote-process-control'
import type { ServeReadiness } from '../server/serve-readiness'

const DEFAULT_READINESS_TIMEOUT_MS = 90_000
const READINESS_POLL_MS = 500
export const STOP_WAIT_SECONDS = 20

export function exec(
  options: Pick<OrcadDeployOptions, 'conn' | 'host' | 'signal'>,
  command: string,
  signal = options.signal
): Promise<string> {
  return execCommand(options.conn, command, {
    wrapCommand: options.host.commandDialect !== 'powershell',
    signal
  })
}

export function withoutAbortSignal<T extends { signal?: AbortSignal }>(
  options: T
): Omit<T, 'signal'> {
  const { signal: _signal, ...recoveryOptions } = options
  return recoveryOptions
}

export async function launchAndAwaitReadiness(
  options: Pick<OrcadDeployOptions, 'conn' | 'host' | 'signal' | 'readinessTimeoutMs' | 'sleep'>,
  spec: OrcadLaunchSpec
): Promise<ReturnType<typeof parseOrcadReadinessOutput>> {
  await exec(options, orcadLaunchCommand(options.host, spec))
  const deadline =
    Date.now() +
    resolveOrcadActivationReadinessTimeout(options.readinessTimeoutMs, DEFAULT_READINESS_TIMEOUT_MS)
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  let last = parseOrcadReadinessOutput('')
  while (Date.now() < deadline) {
    options.signal?.throwIfAborted()
    last = parseOrcadReadinessOutput(
      await exec(options, readOrcadReadinessCommand(options.host, spec.remoteInstallDir))
    )
    if (last.state !== 'pending') {
      return last
    }
    await sleep(READINESS_POLL_MS)
  }
  return last
}

export async function launchAndGate(
  options: OrcadRollbackOptions,
  identity: ActiveRuntimeIdentity
): Promise<{
  verdict: OrcadActivationVerdict
  readiness: ServeReadiness | null
}> {
  const parsed = await launchAndAwaitReadiness(options, {
    remoteInstallDir: identity.remoteDir,
    nodePath: identity.nodePath,
    fullVersion: identity.version,
    userDataDir: options.userDataDir,
    bindHost: options.bindHost,
    port: options.port,
    allowHostNodeFallback: true
  })
  const readiness = parsed.state === 'ready' ? parsed.readiness : null
  return {
    verdict: evaluateOrcadActivation(readiness, {
      buildHash: identity.buildHash,
      fullVersion: identity.version,
      runtimeKind: identity.nodePath ? 'node' : 'bun',
      port: options.port
    }),
    readiness
  }
}

export async function stopOrcadSlot(
  options: Pick<OrcadDeployOptions, 'conn' | 'host' | 'signal'>,
  remoteDir: string
): Promise<ReturnType<typeof parseOrcadStopOutcome>> {
  return parseOrcadStopOutcome(
    await exec(
      options,
      stopOrcadCommand(options.host, remoteDir, { waitSeconds: STOP_WAIT_SECONDS })
    )
  )
}
