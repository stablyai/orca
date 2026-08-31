import { describeNodePtySpawnHelperState } from '../main/pty/node-pty-spawn-helper'

/**
 * Upstream node-pty reports posix_openpt, grantpt, unlockpt, the slave open and the spawn itself as
 * one indistinguishable "posix_spawnp failed." — no step, no errno. Orca patches that away locally,
 * but pnpm patches do not cross the SSH boundary, so a relay always runs the unpatched build.
 */
const OPAQUE_NODE_PTY_SPAWN_FAILURE = /^\s*posix_spawnp failed\.?\s*$/

export function isOpaqueNodePtySpawnFailure(message: string): boolean {
  return OPAQUE_NODE_PTY_SPAWN_FAILURE.test(message)
}

function relayHostDiag(): string {
  return `host: ${process.platform} ${process.arch}, node ${process.versions.node}`
}

/**
 * Wrap a relay PTY spawn failure with the context the client cannot otherwise see.
 *
 * Why: the relay used to rethrow node-pty's error verbatim, so a remote spawn failure reached the
 * terminal toast as a bare "posix_spawnp failed." — no shell, no cwd, no host, and no way to tell a
 * missing spawn-helper from an exhausted pty table.
 *
 * @param nodePtyPackageRoot node-pty dir the relay loaded, when it resolved one off disk.
 */
export function formatRelayPtySpawnError(
  error: unknown,
  shell: string,
  cwd: string,
  nodePtyPackageRoot?: string
): Error {
  const message = error instanceof Error ? error.message : String(error)
  // Only the opaque failure earns the helper probe; a message that already names its step keeps
  // the detail node-pty gave it.
  const detail = isOpaqueNodePtySpawnFailure(message)
    ? `${message} node-pty did not report which step failed (unpatched build). ${describeNodePtySpawnHelperState(nodePtyPackageRoot)}.`
    : message
  const formatted = new Error(
    `Remote host failed to spawn shell "${shell}" with cwd "${cwd}": ${detail} (${relayHostDiag()})`
  )
  if (error instanceof Error && error.stack) {
    formatted.stack = error.stack
  }
  return formatted
}
