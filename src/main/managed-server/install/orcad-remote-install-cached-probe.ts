// One exec asks both pre-lock install questions: "is the pinned runtime cached?" and "is this slot complete?".
import type { NodeRuntimeTarget } from '../../../shared/node-runtime/node-runtime-pin'
import type { OrcadHostTransport } from './orcad-host-transport'
import {
  REMOTE_NODE_RUNTIME_MISSING,
  REMOTE_NODE_RUNTIME_READY
} from './orcad-remote-node-runtime-report'
import { probeRemoteInstallCompleteCommand } from './remote-install-completeness-command'
import {
  execCommand,
  isUnconfirmedSshCommandTermination
} from '../../ssh/remote-exec/remote-exec-command'
import {
  isWindowsRemoteHost,
  type RemoteHostPlatform
} from '../../ssh/remote-host/ssh-remote-platform'
import {
  NODE_RUNTIME_PROMOTE_TIMEOUT_MS,
  probeRemoteNodeRuntimeCommand,
  remoteNodeRuntimeDir
} from './orcad-remote-node-runtime'
import { recordedRemoteNodeRuntimeProbeCommand } from './orcad-remote-node-runtime-recorded-probe'
import { ORCAD_INSTALL_MODEL } from './remote-install-model'

const SECTION_END = '__ORCA_CACHED_SLOT_PROBE_END__'

export type CachedOrcadSlotState = { runtimeReady: boolean; slotComplete: boolean }

/** `recordedRuntime` is the WSL opt-in that trusts a recorded stat signature; otherwise it hashes. */
export function cachedOrcadSlotProbeCommand(
  host: RemoteHostPlatform,
  remoteDir: string,
  target: NodeRuntimeTarget,
  recordedRuntime: boolean
): string {
  const runtimeDir = remoteNodeRuntimeDir(host, remoteDir, target)
  const runtimeProbe = recordedRuntime
    ? recordedRemoteNodeRuntimeProbeCommand
    : probeRemoteNodeRuntimeCommand
  return [
    runtimeProbe(host, runtimeDir, target),
    `printf '\\n%s\\n' ${SECTION_END}`,
    probeRemoteInstallCompleteCommand(host, remoteDir, [
      ...ORCAD_INSTALL_MODEL.requiredArtifacts(host),
      ORCAD_INSTALL_MODEL.installCompleteFilename
    ])
  ].join('; ')
}

/**
 * The same two answers the separate probes give, or null (Windows, a failed exec, or an answer of
 * another shape), when the caller runs the separate probes as before.
 */
export async function readCachedOrcadSlotState(
  options: {
    conn: OrcadHostTransport
    host: RemoteHostPlatform
    target: NodeRuntimeTarget
    recordedNodeRuntimeProbe?: boolean
    signal?: AbortSignal
  },
  remoteDir: string
): Promise<CachedOrcadSlotState | null> {
  if (isWindowsRemoteHost(options.host)) {
    return null
  }
  try {
    const output = await execCommand(
      options.conn,
      cachedOrcadSlotProbeCommand(
        options.host,
        remoteDir,
        options.target,
        options.recordedNodeRuntimeProbe === true
      ),
      { signal: options.signal, timeoutMs: NODE_RUNTIME_PROMOTE_TIMEOUT_MS, wrapCommand: true }
    )
    const [runtime, install, ...rest] = output
      .split(`\n${SECTION_END}\n`)
      .map((part) => part.trim())
    if (
      rest.length !== 0 ||
      (runtime !== REMOTE_NODE_RUNTIME_READY && runtime !== REMOTE_NODE_RUNTIME_MISSING) ||
      (install !== 'OK' && install !== 'MISSING')
    ) {
      return null
    }
    return { runtimeReady: runtime === REMOTE_NODE_RUNTIME_READY, slotComplete: install === 'OK' }
  } catch (error) {
    if (isUnconfirmedSshCommandTermination(error)) {
      throw error
    }
    options.signal?.throwIfAborted()
    return null
  }
}
