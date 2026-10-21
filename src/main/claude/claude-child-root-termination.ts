import type { SpawnedProcess } from '@orca/process-host/process-spec'

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
 * On POSIX the root is the provider supervisor, killed only after its own stop had
 * its whole bound; Claude, in its own group, is reached by the descendant kill.
 *
 * False means no signal was sent, because the root had already left.
 */
export function terminateClaudeRoot(input: RootTerminationInput): boolean {
  return input.exited() ? false : input.child.kill('SIGKILL')
}
