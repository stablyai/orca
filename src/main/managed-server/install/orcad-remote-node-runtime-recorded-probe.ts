/**
 * The runtime probe for hosts that opt in (WSL guests): the ~110 MiB executable is hashed only
 * when its stat signature differs from the one recorded the last time it hashed to the pin.
 * A republish renames a new inode into place and an in-place write moves ctime, so either change
 * forces the full hash again (verify on mismatch).
 */
import { pinnedNodeRuntimeAsset, type NodeRuntimeTarget } from '../../../shared/node-runtime-pin'
import { quotePosixShell } from '../../../shared/shell-argument-quoting'
import { joinRemotePath, type RemoteHostPlatform } from '../../ssh/ssh-remote-platform'
import { assertPosixOrcadHost } from './orcad-remote-host-support'
import {
  REMOTE_NODE_RUNTIME_MISSING,
  REMOTE_NODE_RUNTIME_READY,
  REMOTE_NODE_RUNTIME_VERIFIED_MARKER
} from '../../ssh/orcad-remote-node-runtime-report'
import { posixNodeRuntimeExecutable, remoteSha256Command } from './orcad-remote-node-runtime'

/** Beside `.verified`; store GC removes it with its runtime directory. */
export const REMOTE_NODE_RUNTIME_HASHED_STAT_FILENAME = '.verified-stat'

/** Same verdicts as `probeRemoteNodeRuntimeCommand`, against `executableSha256`. */
export function recordedNodeRuntimeProbeCommand(
  host: RemoteHostPlatform,
  runtimeDir: string,
  executableSha256: string
): string {
  assertPosixOrcadHost(host)
  const executable = quotePosixShell(posixNodeRuntimeExecutable(host, runtimeDir))
  const verified = quotePosixShell(
    joinRemotePath(host, runtimeDir, REMOTE_NODE_RUNTIME_VERIFIED_MARKER)
  )
  const record = quotePosixShell(
    joinRemotePath(host, runtimeDir, REMOTE_NODE_RUNTIME_HASHED_STAT_FILENAME)
  )
  const pin = quotePosixShell(executableSha256)
  // GNU/busybox `stat -c`, else BSD `stat -f`; an empty signature never matches and is never kept.
  const signature =
    `{ stat -L -c '%d:%i:%s:%y:%z' ${executable} || ` +
    `stat -L -f '%d:%i:%z:%Fm:%Fc' ${executable}; } 2>/dev/null`
  const remember =
    `if [ -n "$orca_rt_sig" ]; then ` +
    `{ printf '%s\\n' ${pin}:"$orca_rt_sig" > ${record}.$$ && mv -f ${record}.$$ ${record}; } 2>/dev/null || ` +
    `rm -f ${record}.$$; fi`
  return (
    `if [ -f ${verified} ] && [ -x ${executable} ]; then ` +
    `orca_rt_sig=$(${signature}); ` +
    `if [ -n "$orca_rt_sig" ] && [ ${pin}:"$orca_rt_sig" = "$(cat ${record} 2>/dev/null)" ]; ` +
    `then echo ${REMOTE_NODE_RUNTIME_READY}; ` +
    `elif [ "$(${remoteSha256Command(executable)})" = ${pin} ]; ` +
    `then ${remember}; echo ${REMOTE_NODE_RUNTIME_READY}; ` +
    `else echo ${REMOTE_NODE_RUNTIME_MISSING}; fi; ` +
    `else echo ${REMOTE_NODE_RUNTIME_MISSING}; fi`
  )
}

export function recordedRemoteNodeRuntimeProbeCommand(
  host: RemoteHostPlatform,
  runtimeDir: string,
  target: NodeRuntimeTarget
): string {
  return recordedNodeRuntimeProbeCommand(
    host,
    runtimeDir,
    pinnedNodeRuntimeAsset(target).executableSha256
  )
}
