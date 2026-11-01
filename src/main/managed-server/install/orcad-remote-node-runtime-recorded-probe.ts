// WSL opt-in reuses verified runtime stat signatures; inode replacement or in-place ctime change forces a full hash.
import { pinnedNodeRuntimeAsset, type NodeRuntimeTarget } from '../../../shared/node-runtime-pin'
import { quotePosixShell } from '../../../shared/shell-argument-quoting'
import { joinRemotePath, type RemoteHostPlatform } from '../../ssh/ssh-remote-platform'
import { assertPosixOrcadHost } from './orcad-remote-host-support'
import {
  REMOTE_NODE_RUNTIME_MISSING,
  REMOTE_NODE_RUNTIME_READY,
  REMOTE_NODE_RUNTIME_VERIFIED_MARKER
} from '../../ssh/orcad-remote-node-runtime-report'
import { posixNodeRuntimeExecutable } from './orcad-remote-node-runtime'
import { remoteSha256Command } from './remote-sha256-command'

export const REMOTE_NODE_RUNTIME_HASHED_STAT_FILENAME = '.verified-stat'

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
  // Try GNU/BusyBox then BSD stat; empty signatures cannot be trusted or retained.
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
