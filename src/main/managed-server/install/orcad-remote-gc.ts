// GC only orcad-owned slots; pin active, rollback, live-daemon and journal versions, skipping collection when recovery state is unreadable.
import type { OrcadHostTransport } from '../../ssh/orcad-host-transport'
import {
  execCommand,
  isUnconfirmedSshCommandTermination
} from '../../ssh/remote-exec/remote-exec-command'
import { ORCAD_INSTALL_MODEL } from './remote-install-model'
import { gcOldRemoteInstallVersions } from './remote-install-gc'
import {
  orcadGcPinnedDirNames,
  type OrcadActivationRecord
} from '../activation/orcad-activation-record'
import {
  ORCAD_NEVER_LAUNCHED,
  orcadLivenessAnswerBlocksGc,
  orcadLivenessProbeCommand
} from './orcad-remote-launch'
import { gcRemoteNodeRuntimeStore } from './remote-node-runtime-store-gc'
import { readOrcadGcTransactionPins } from '../../ssh/orcad-gc-transaction-pins'
import {
  isWindowsRemoteHost,
  joinRemotePath,
  type RemoteHostPlatform
} from '../../ssh/ssh-remote-platform'
import { RELAY_REMOTE_DIR } from '../../ssh/remote-exec/remote-frame-protocol'
import { orcadWindowsHomeOpCommand } from './orcad-remote-windows-node'
import { ORCAD_WINDOWS_LIVENESS_MANY_MARKER } from '../host-state/orcad-windows-host-script'

type OrcadGcOptions = {
  conn: OrcadHostTransport
  host: RemoteHostPlatform
  remoteHome: string
  currentDirAbsPath: string
  record: OrcadActivationRecord
  /** A live daemon can still execute an outgoing bundle no longer active or previous; keep its bytes. */
  liveDaemonVersion?: string | null
  /** Current executable hashes both pin runtimes and authorize runtime-store GC. */
  nodeRuntimePins?: readonly string[]
  signal?: AbortSignal
}

/** True when no stale version dir was left behind (skipped, kept or unlistable ones make it false). */
export async function gcOldOrcadVersions(options: OrcadGcOptions): Promise<boolean> {
  const transaction = await readOrcadGcTransactionPins(options)
  if (transaction.state === 'keep-all') {
    console.warn('[orcad-gc] An activation transaction is unreadable or unjournaled; skipping GC.')
    return false
  }
  const versionsClean = await gcOldRemoteInstallVersions(
    options.conn,
    ORCAD_INSTALL_MODEL,
    options.remoteHome,
    options.currentDirAbsPath,
    options.host,
    {
      pinnedDirNames: [
        ...orcadGcPinnedDirNames(options.record, options.liveDaemonVersion),
        ...transaction.dirNames
      ],
      // Screen Windows candidates together, then recheck dead candidates individually under the GC claim.
      ...(isWindowsRemoteHost(options.host)
        ? { resolveExtraPinnedDirNames: (candidates) => windowsLiveCandidates(options, candidates) }
        : {}),
      isDirLive: async (dir) => {
        try {
          const probe = await execCommand(
            options.conn,
            orcadLivenessProbeCommand(options.host, dir),
            {
              wrapCommand: options.host.commandDialect !== 'powershell',
              signal: options.signal
            }
          )
          return orcadLivenessAnswerBlocksGc(probe)
        } catch (error) {
          if (isUnconfirmedSshCommandTermination(error)) {
            throw error
          }
          // Failed probes cannot prove the tree is idle.
          return true
        }
      }
    }
  )
  // Remove slots before runtimes so their references are released first.
  if (options.nodeRuntimePins?.length) {
    await gcRemoteNodeRuntimeStore(options.conn, options.host, options.remoteHome, {
      currentPins: options.nodeRuntimePins,
      signal: options.signal
    })
  }
  return versionsClean
}

/** Null means unknown host state and keeps every candidate; otherwise pin anything not proven dead. */
async function windowsLiveCandidates(
  options: OrcadGcOptions,
  candidates: readonly string[]
): Promise<readonly string[] | null> {
  const dirs = candidates.map((name) =>
    joinRemotePath(options.host, options.remoteHome, RELAY_REMOTE_DIR, name)
  )
  let output: string
  try {
    output = await execCommand(
      options.conn,
      orcadWindowsHomeOpCommand(options.host, options.remoteHome, 'liveness-many', dirs),
      { wrapCommand: false, signal: options.signal }
    )
  } catch (error) {
    if (isUnconfirmedSshCommandTermination(error)) {
      throw error
    }
    return null
  }
  const line = output
    .split(/\r?\n/u)
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.startsWith(`${ORCAD_WINDOWS_LIVENESS_MANY_MARKER} `))
  const states = line?.slice(ORCAD_WINDOWS_LIVENESS_MANY_MARKER.length + 1).split(',') ?? []
  if (states.length !== candidates.length) {
    return null
  }
  return candidates.filter(
    (_name, index) => states[index] !== 'DEAD' && states[index] !== ORCAD_NEVER_LAUNCHED
  )
}
