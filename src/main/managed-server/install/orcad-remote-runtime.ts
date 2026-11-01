import {
  ORCAD_BUILD_TARGET_FILENAME,
  ORCAD_LAUNCHER_FILENAME,
  ORCAD_SERVER_ENTRY_FILENAME,
  ORCAD_NODE_RUNTIME_DIR_PREFIX,
  ORCAD_NODE_RUNTIME_MARKER_FILENAME,
  ORCAD_NODE_RUNTIME_POSIX_EXECUTABLE,
  ORCAD_RUNTIMES_DIRNAME,
  orcadBunRuntimeFilename
} from '../../../shared/orcad-artifacts'
import { assertPosixOrcadHost } from './orcad-remote-host-support'
import { quotePosixShell } from '../../../shared/shell-argument-quoting'
import { joinRemotePath, type RemoteHostPlatform } from '../../ssh/ssh-remote-platform'

// Assign the long slot path once to reduce command size on the wire.
function assignOrcadSlot(directory: string): string {
  return `orcad_slot=${quotePosixShell(directory.replace(/\/+$/, ''))}; `
}

// Rollback must still accept legacy single-entry slots.
export function selectOrcadSlotEntryCommand(host: RemoteHostPlatform, directory: string): string {
  assertPosixOrcadHost(host)
  const server = `"$orcad_slot"/${quotePosixShell(ORCAD_SERVER_ENTRY_FILENAME)}`
  const launcher = `"$orcad_slot"/${quotePosixShell(ORCAD_LAUNCHER_FILENAME)}`
  return `${assignOrcadSlot(directory)}if [ -f ${server} ]; then orcad_entry=${server}; else orcad_entry=${launcher}; fi`
}

/** Set $orcad_runtime or exit 78; callers decide what an absent marker means. */
export function orcadNodeSlotRuntimeCommand(host: RemoteHostPlatform, directory: string): string {
  assertPosixOrcadHost(host)
  const nodeMarker = `"$orcad_slot"/${quotePosixShell(ORCAD_NODE_RUNTIME_MARKER_FILENAME)}`
  const nodeRuntimePrefix = `"\${orcad_slot%/*}"/${quotePosixShell(
    `${ORCAD_RUNTIMES_DIRNAME}/${ORCAD_NODE_RUNTIME_DIR_PREFIX}`
  )}`
  const nodeExecutable = quotePosixShell(`/${ORCAD_NODE_RUNTIME_POSIX_EXECUTABLE}`)
  return (
    `${assignOrcadSlot(directory)}orcad_node_sha=$(cat ${nodeMarker}) || exit 78; ` +
    // The digest becomes a path segment; reject non-SHA256 values.
    // Leading ( keeps the case pattern parseable inside command substitution.
    'case "$orcad_node_sha" in ("" | *[!0-9a-f]*) exit 78;; esac; ' +
    '[ "${#orcad_node_sha}" -eq 64 ] || exit 78; ' +
    `orcad_runtime=${nodeRuntimePrefix}"$orcad_node_sha"${nodeExecutable}; ` +
    '[ -x "$orcad_runtime" ] || exit 78; '
  )
}

/** Legacy host Node fallback must never hide an incomplete Node or Bun slot. */
export function selectOrcadSlotRuntimeCommand(
  host: RemoteHostPlatform,
  directory: string,
  legacyNodePath: string
): string {
  assertPosixOrcadHost(host)
  const nodeMarker = quotePosixShell(
    joinRemotePath(host, directory, ORCAD_NODE_RUNTIME_MARKER_FILENAME)
  )
  const runtime = quotePosixShell(joinRemotePath(host, directory, orcadBunRuntimeFilename(host.os)))
  const target = quotePosixShell(joinRemotePath(host, directory, ORCAD_BUILD_TARGET_FILENAME))
  return (
    `if [ -e ${nodeMarker} ]; then ${orcadNodeSlotRuntimeCommand(host, directory)}` +
    `elif [ -e ${target} ] || [ -e ${runtime} ]; then ` +
    `[ -x ${runtime} ] || exit 78; orcad_runtime=${runtime}; ` +
    `else orcad_runtime=${quotePosixShell(legacyNodePath)}; fi`
  )
}
