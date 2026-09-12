import type { OrcadActivationRecoveryOptions } from './orcad-activation-recovery'
import type { ServeReadiness } from '../server/serve-readiness'
import { ORCAD_INSTALL_MODEL } from './remote-install-model'
import { computeRemoteInstallDir } from './ssh-relay-versioned-install'
import { readRemoteOrcadBuildHash } from './orcad-remote-build-hash'
import { resolveOrcadSlotNodeFallback } from './orcad-slot-runtime-eligibility'
import {
  launchOrcadSlotAndAwaitReadiness,
  probeActiveOrcadReadiness
} from './orcad-active-readiness'
import { orcadLivenessProbeCommand, parseOrcadLiveness } from './orcad-remote-launch'
import { execCommand } from './ssh-relay-deploy-helpers'

type SlotIdentity = {
  version: string
  remoteDir: string
  buildHash: string
  nodePath?: string
  runtimeKind: 'bun' | 'node'
}

export async function ensureRecordedRuntimeServing(
  options: OrcadActivationRecoveryOptions,
  version: string
): Promise<ServeReadiness> {
  const identity = await resolveSlotIdentity(options, version)
  const liveness = parseOrcadLiveness(
    await executeOrcadRecoveryCommand(
      options,
      orcadLivenessProbeCommand(options.host, identity.remoteDir)
    )
  )
  if (liveness === 'LIVE') {
    return probeSlot(options, identity)
  }
  if (liveness === 'UNKNOWN') {
    throw new Error(`orcad ${version} process state is unverifiable.`)
  }
  return launchOrcadSlotAndAwaitReadiness({
    conn: options.conn,
    host: options.host,
    remoteInstallDir: identity.remoteDir,
    nodePath: identity.nodePath,
    fullVersion: identity.version,
    userDataDir: options.userDataDir,
    bindHost: options.bindHost,
    port: options.port,
    buildHash: identity.buildHash,
    runtimeKind: identity.runtimeKind,
    readinessTimeoutMs: options.readinessTimeoutMs,
    signal: options.signal,
    sleep: options.sleep
  })
}

export async function recordedRuntimeIsServing(
  options: OrcadActivationRecoveryOptions,
  version: string
): Promise<boolean> {
  try {
    const identity = await resolveSlotIdentity(options, version)
    const liveness = parseOrcadLiveness(
      await executeOrcadRecoveryCommand(
        options,
        orcadLivenessProbeCommand(options.host, identity.remoteDir)
      )
    )
    if (liveness !== 'LIVE') {
      return false
    }
    await probeSlot(options, identity)
    return true
  } catch {
    return false
  }
}

function probeSlot(
  options: OrcadActivationRecoveryOptions,
  identity: SlotIdentity
): Promise<ServeReadiness> {
  return probeActiveOrcadReadiness({
    conn: options.conn,
    host: options.host,
    remoteInstallDir: identity.remoteDir,
    fullVersion: identity.version,
    buildHash: identity.buildHash,
    runtimeKind: identity.runtimeKind,
    port: options.port,
    signal: options.signal
  })
}

async function resolveSlotIdentity(
  options: OrcadActivationRecoveryOptions,
  version: string
): Promise<SlotIdentity> {
  const remoteDir = orcadRecoveryInstallDir(options, version)
  const [buildHash, nodePath] = await Promise.all([
    readRemoteOrcadBuildHash({ ...options, remoteInstallDir: remoteDir }),
    resolveOrcadSlotNodeFallback(options.conn, options.host, remoteDir, options.signal)
  ])
  return {
    version,
    remoteDir,
    buildHash,
    ...(nodePath ? { nodePath } : {}),
    runtimeKind: nodePath ? 'node' : 'bun'
  }
}

export function orcadRecoveryInstallDir(
  options: OrcadActivationRecoveryOptions,
  version: string
): string {
  return computeRemoteInstallDir(
    ORCAD_INSTALL_MODEL,
    options.remoteHome,
    version,
    options.host.pathFlavor
  )
}

export function executeOrcadRecoveryCommand(
  options: OrcadActivationRecoveryOptions,
  command: string
): Promise<string> {
  return execCommand(options.conn, command, {
    wrapCommand: options.host.commandDialect !== 'powershell',
    signal: options.signal
  })
}
