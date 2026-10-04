import {
  ORCAD_BUILD_TARGET_FILENAME,
  ORCAD_NODE_RUNTIME_DIR_PREFIX,
  ORCAD_NODE_RUNTIME_MARKER_FILENAME,
  ORCAD_NODE_RUNTIME_POSIX_EXECUTABLE,
  ORCAD_RUNTIMES_DIRNAME,
  orcadBunRuntimeFilename
} from '../../shared/orcad-artifacts'
import { assertPosixOrcadHost } from './orcad-remote-host-support'
import { shellEscape } from './ssh-connection-utils'
import { joinRemotePath, remoteDirname, type RemoteHostPlatform } from './ssh-remote-platform'

/**
 * Sets `$orcad_runtime` to the pinned Node a slot's `.runtime-node` names, or exits 78.
 * Assumes the marker exists; callers decide what its absence means.
 */
export function orcadNodeSlotRuntimeCommand(host: RemoteHostPlatform, directory: string): string {
  assertPosixOrcadHost(host)
  const nodeMarker = shellEscape(
    joinRemotePath(host, directory, ORCAD_NODE_RUNTIME_MARKER_FILENAME)
  )
  const nodeRuntimePrefix = shellEscape(
    joinRemotePath(
      host,
      remoteDirname(directory.replace(/\/+$/, ''), host),
      ORCAD_RUNTIMES_DIRNAME,
      ORCAD_NODE_RUNTIME_DIR_PREFIX
    )
  )
  const nodeExecutable = shellEscape(`/${ORCAD_NODE_RUNTIME_POSIX_EXECUTABLE}`)
  return (
    `orcad_node_sha=$(cat ${nodeMarker}) || exit 78; ` +
    // Why validate: the digest becomes a path segment, so only a bare sha256 may reach it.
    // The leading `(` keeps the pattern parseable when stop embeds this in `$(...)`.
    'case "$orcad_node_sha" in ("" | *[!0-9a-f]*) exit 78;; esac; ' +
    '[ "${#orcad_node_sha}" -eq 64 ] || exit 78; ' +
    `orcad_runtime=${nodeRuntimePrefix}"$orcad_node_sha"${nodeExecutable}; ` +
    '[ -x "$orcad_runtime" ] || exit 78; '
  )
}

/**
 * The slot's own contents pick its runtime: Node marker, then Bun, then legacy host Node.
 * Only legacy slots may use host Node; an incomplete Node or Bun slot must not change runtimes.
 */
export function selectOrcadSlotRuntimeCommand(
  host: RemoteHostPlatform,
  directory: string,
  legacyNodePath: string
): string {
  assertPosixOrcadHost(host)
  const nodeMarker = shellEscape(
    joinRemotePath(host, directory, ORCAD_NODE_RUNTIME_MARKER_FILENAME)
  )
  const runtime = shellEscape(joinRemotePath(host, directory, orcadBunRuntimeFilename(host.os)))
  const target = shellEscape(joinRemotePath(host, directory, ORCAD_BUILD_TARGET_FILENAME))
  return (
    `if [ -e ${nodeMarker} ]; then ${orcadNodeSlotRuntimeCommand(host, directory)}` +
    `elif [ -e ${target} ] || [ -e ${runtime} ]; then ` +
    `[ -x ${runtime} ] || exit 78; orcad_runtime=${runtime}; ` +
    `else orcad_runtime=${shellEscape(legacyNodePath)}; fi`
  )
}
