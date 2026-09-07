import type { SpawnedProcess } from '../../shared/child-process/run-process'
import type { PosixProcessIdentity } from '../pty-descendant-termination'
import type {
  WindowsDescendantSnapshot,
  WindowsProcessIdentity
} from '../windows-descendant-exit-verification'

export type ClaudeRootIdentity = PosixProcessIdentity | WindowsProcessIdentity

type RootTerminationInput = {
  child: Pick<SpawnedProcess, 'kill'>
  exited: () => boolean
}

/**
 * Kills the root through the handle Node owns rather than through its pid, which
 * is why no identity probe gates it: libuv drops that handle in the same turn it
 * reaps, so the signal either reaches the process Orca spawned or reaches
 * nothing. A probe here could only let an unreadable process table cost the tree
 * the one fallback that still works once every table read has failed.
 *
 * False means no signal was sent, because the root had already left.
 */
export function terminateClaudeRoot(input: RootTerminationInput): boolean {
  return input.exited() ? false : input.child.kill('SIGKILL')
}

type WindowsRootTerminationInput = {
  snapshot: WindowsDescendantSnapshot | null
  exited: () => boolean
  verifyRoot: (root: WindowsProcessIdentity) => Promise<boolean>
  terminateTree: (root: WindowsProcessIdentity) => Promise<void>
  killRoot: () => boolean
}

/**
 * `taskkill /T /F` addresses a bare pid, so a dead root's pid may already belong
 * to a stranger whose whole tree it would take down: that one is identity-gated.
 * The direct root kill after it runs however the probe decided.
 */
export async function terminateClaudeWindowsRoot(
  input: WindowsRootTerminationInput
): Promise<{ rootVerified: boolean }> {
  const { snapshot, exited, verifyRoot, terminateTree, killRoot } = input
  let rootVerified = false
  if (!exited() && snapshot) {
    rootVerified = await verifyRoot(snapshot.root).catch(() => false)
    if (rootVerified && !exited()) {
      await terminateTree(snapshot.root).catch(() => {})
    }
  }
  killRoot()
  return { rootVerified }
}
