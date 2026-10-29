// WSL opt-in: one exec asks both "is the pinned runtime cached?" and "is this slot complete?".
import type { NodeRuntimeTarget } from '../../../shared/node-runtime-pin'
import type { OrcadHostTransport } from '../../ssh/orcad-host-transport'
import { REMOTE_NODE_RUNTIME_READY } from '../../ssh/orcad-remote-node-runtime-report'
import { probeRemoteInstallCompleteCommand } from '../../ssh/ssh-remote-commands'
import {
  execCommand,
  isUnconfirmedSshCommandTermination
} from '../../ssh/remote-exec/remote-exec-command'
import { isWindowsRemoteHost, type RemoteHostPlatform } from '../../ssh/ssh-remote-platform'
import { NODE_RUNTIME_PROMOTE_TIMEOUT_MS, remoteNodeRuntimeDir } from './orcad-remote-node-runtime'
import { recordedRemoteNodeRuntimeProbeCommand } from './orcad-remote-node-runtime-recorded-probe'
import { ORCAD_INSTALL_MODEL } from './remote-install-model'

const SECTION_END = '__ORCA_CACHED_SLOT_PROBE_END__'

export function cachedOrcadSlotProbeCommand(
  host: RemoteHostPlatform,
  remoteDir: string,
  target: NodeRuntimeTarget
): string {
  const runtimeDir = remoteNodeRuntimeDir(host, remoteDir, target)
  return [
    recordedRemoteNodeRuntimeProbeCommand(host, runtimeDir, target),
    `printf '\\n%s\\n' ${SECTION_END}`,
    probeRemoteInstallCompleteCommand(host, remoteDir, [
      ...ORCAD_INSTALL_MODEL.requiredArtifacts(host),
      ORCAD_INSTALL_MODEL.installCompleteFilename
    ])
  ].join('; ')
}

/**
 * True only when both answers say the install can be skipped, which is where the separate
 * probes return too; anything else (including a failed exec) leaves them to run as usual.
 */
export async function cachedOrcadSlotInstalled(
  options: {
    conn: OrcadHostTransport
    host: RemoteHostPlatform
    target: NodeRuntimeTarget
    signal?: AbortSignal
  },
  remoteDir: string
): Promise<boolean> {
  if (isWindowsRemoteHost(options.host)) {
    return false
  }
  try {
    const output = await execCommand(
      options.conn,
      cachedOrcadSlotProbeCommand(options.host, remoteDir, options.target),
      { signal: options.signal, timeoutMs: NODE_RUNTIME_PROMOTE_TIMEOUT_MS, wrapCommand: true }
    )
    const [runtime, install, ...rest] = output.split(`\n${SECTION_END}\n`)
    return (
      rest.length === 0 && runtime?.trim() === REMOTE_NODE_RUNTIME_READY && install?.trim() === 'OK'
    )
  } catch (error) {
    if (isUnconfirmedSshCommandTermination(error)) {
      throw error
    }
    options.signal?.throwIfAborted()
    return false
  }
}
