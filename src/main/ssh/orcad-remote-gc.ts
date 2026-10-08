/**
 * orcad's garbage collection, and who owns it (design D10; to be tracked in
 * docs/reference/remote-server-install-model.md).
 *
 * **Each model GCs only its own namespace.** orcad removes `orcad-<v>/` directories; the relay
 * removes `relay-<v>/` directories; neither ever removes the other's. The converged server's
 * migration sweep takes over legacy directories only in the release after it has listed them
 * as diagnostics, and only on an `exited` verdict. A pass that deleted the sibling's tree
 * would be reaching across the execution boundary the whole design exists to keep intact.
 *
 * On top of the ownership rule, orcad pins three directories that are idle-looking but
 * load-bearing: the active version, the rollback target, and whichever version the LIVE
 * terminal daemon was forked from. Every version an in-flight activation journal names is
 * pinned too, and an unreadable journal skips the pass entirely.
 */
import type { SshConnection } from './ssh-connection'
import { execCommand } from './ssh-relay-deploy-helpers'
import { isUnconfirmedSshCommandTermination } from './ssh-relay-exec-command'
import { ORCAD_INSTALL_MODEL } from './remote-install-model'
import { gcOldRemoteInstallVersions } from './ssh-relay-versioned-install'
import { orcadGcPinnedDirNames, type OrcadActivationRecord } from './orcad-activation-record'
import {
  ORCAD_NEVER_LAUNCHED,
  orcadLivenessAnswerBlocksGc,
  orcadLivenessProbeCommand
} from './orcad-remote-launch'
import { gcRemoteNodeRuntimeStore } from './remote-node-runtime-store-gc'
import { readOrcadGcTransactionPins } from './orcad-gc-transaction-pins'
import { isWindowsRemoteHost, joinRemotePath, type RemoteHostPlatform } from './ssh-remote-platform'
import { RELAY_REMOTE_DIR } from './relay-protocol'
import { orcadRemoteBaseDir, orcadWindowsHostOpCommand } from './orcad-remote-windows-node'
import { ORCAD_WINDOWS_LIVENESS_MANY_MARKER } from './orcad-windows-host-script'

export type OrcadGcOptions = {
  conn: SshConnection
  host: RemoteHostPlatform
  remoteHome: string
  /** Absolute path of the version dir this client just used; never a candidate. */
  currentDirAbsPath: string
  record: OrcadActivationRecord
  /**
   * The full version the live daemon's PID record names, when it can be read.
   *
   * An update preserves a daemon forked from the OUTGOING bundle whenever terminals are
   * live, so this is routinely a version that is neither active nor previous. Deleting it
   * would remove the tree under a running process.
   */
  liveDaemonVersion?: string | null
  /**
   * executableSha256 of every runtime pin this client runs. Also the gate for the shared
   * runtime store pass: without it this client cannot say which runtime is current.
   */
  nodeRuntimePins?: readonly string[]
  signal?: AbortSignal
}

export async function gcOldOrcadVersions(options: OrcadGcOptions): Promise<void> {
  const transaction = await readOrcadGcTransactionPins(options)
  if (transaction.state === 'keep-all') {
    console.warn('[orcad-gc] An activation transaction is unreadable or unjournaled; skipping GC.')
    return
  }
  await gcOldRemoteInstallVersions(
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
      // Windows screens every candidate in one node.exe; the per-dir probe below rechecks only
      // the few that screened dead, under the GC claim.
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
          // Why true: an unanswered probe is not evidence a tree is idle. Same rule the
          // relay's socket probe applies, for the same reason.
          return true
        }
      }
    }
  )
  // Why after the version pass: removing version dirs is what drops their runtime references.
  if (options.nodeRuntimePins?.length) {
    await gcRemoteNodeRuntimeStore(options.conn, options.host, options.remoteHome, {
      currentPins: options.nodeRuntimePins,
      signal: options.signal
    })
  }
}

/** Candidates that are not proven dead, as pins; null (keep everything) when the host cannot say. */
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
      orcadWindowsHostOpCommand(
        options.host,
        orcadRemoteBaseDir(options.host, options.remoteHome),
        'liveness-many',
        dirs
      ),
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
