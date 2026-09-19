import { evaluateOrcadActivation } from './orcad-activation-gate'
import type { SshConnection } from './ssh-connection'
import { execCommand } from './ssh-relay-deploy-helpers'
import {
  orcadLaunchCommand,
  orcadLivenessProbeCommand,
  parseOrcadLiveness,
  parseOrcadReadinessOutput,
  readOrcadReadinessCommand
} from './orcad-remote-launch'
import type { RemoteHostPlatform } from './ssh-remote-platform'
import type { ServeReadiness } from '../server/serve-readiness'
import { resolveOrcadActivationReadinessTimeout } from './orcad-activation-lock'
import type { OrcadBunTarget } from '../../shared/orcad-bun-runtime'

const DEFAULT_READINESS_TIMEOUT_MS = 90_000
const READINESS_POLL_MS = 500

export async function probeActiveOrcadReadiness(options: {
  conn: SshConnection
  host: RemoteHostPlatform
  remoteInstallDir: string
  fullVersion: string
  buildHash: string
  runtimeKind: 'bun' | 'node'
  buildTarget?: OrcadBunTarget
  port: number
  signal?: AbortSignal
}): Promise<ServeReadiness> {
  const exec = (command: string): Promise<string> =>
    execCommand(options.conn, command, {
      wrapCommand: options.host.commandDialect !== 'powershell',
      signal: options.signal
    })
  const liveness = parseOrcadLiveness(
    await exec(orcadLivenessProbeCommand(options.host, options.remoteInstallDir))
  )
  if (liveness !== 'LIVE') {
    throw new Error(
      liveness === 'DEAD'
        ? `orcad ${options.fullVersion} is recorded active but its process has exited.`
        : `orcad ${options.fullVersion} process state is unverifiable.`
    )
  }
  const parsed = parseOrcadReadinessOutput(
    await exec(readOrcadReadinessCommand(options.host, options.remoteInstallDir))
  )
  const verdict = evaluateOrcadActivation(parsed.state === 'ready' ? parsed.readiness : null, {
    buildHash: options.buildHash,
    fullVersion: options.fullVersion,
    runtimeKind: options.runtimeKind,
    ...(options.buildTarget ? { buildTarget: options.buildTarget } : {}),
    port: options.port
  })
  if (verdict.decision === 'reject') {
    throw new Error(`The active orcad failed its readiness check: ${verdict.reason}`)
  }
  if (parsed.state !== 'ready') {
    throw new Error('The active orcad passed activation without a readiness payload.')
  }
  return parsed.readiness
}

export async function launchOrcadSlotAndAwaitReadiness(options: {
  conn: SshConnection
  host: RemoteHostPlatform
  remoteInstallDir: string
  nodePath?: string
  fullVersion: string
  userDataDir: string
  bindHost: string
  port: number
  buildHash: string
  runtimeKind: 'bun' | 'node'
  buildTarget?: OrcadBunTarget
  readinessTimeoutMs?: number
  signal?: AbortSignal
  sleep?: (ms: number) => Promise<void>
}): Promise<ServeReadiness> {
  const exec = (command: string): Promise<string> =>
    execCommand(options.conn, command, {
      wrapCommand: options.host.commandDialect !== 'powershell',
      signal: options.signal
    })
  await exec(
    orcadLaunchCommand(options.host, {
      remoteInstallDir: options.remoteInstallDir,
      nodePath: options.nodePath,
      fullVersion: options.fullVersion,
      userDataDir: options.userDataDir,
      bindHost: options.bindHost,
      port: options.port,
      allowHostNodeFallback: true
    })
  )
  const deadline =
    Date.now() +
    resolveOrcadActivationReadinessTimeout(options.readinessTimeoutMs, DEFAULT_READINESS_TIMEOUT_MS)
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  let parsed = parseOrcadReadinessOutput('')
  while (Date.now() < deadline && parsed.state === 'pending') {
    options.signal?.throwIfAborted()
    parsed = parseOrcadReadinessOutput(
      await exec(readOrcadReadinessCommand(options.host, options.remoteInstallDir))
    )
    if (parsed.state === 'pending') {
      await sleep(READINESS_POLL_MS)
    }
  }
  const verdict = evaluateOrcadActivation(parsed.state === 'ready' ? parsed.readiness : null, {
    buildHash: options.buildHash,
    fullVersion: options.fullVersion,
    runtimeKind: options.runtimeKind,
    ...(options.buildTarget ? { buildTarget: options.buildTarget } : {}),
    port: options.port
  })
  if (verdict.decision === 'reject') {
    throw new Error(`The recovered orcad failed its readiness check: ${verdict.reason}`)
  }
  if (parsed.state !== 'ready') {
    throw new Error('The recovered orcad passed activation without a readiness payload.')
  }
  return parsed.readiness
}
