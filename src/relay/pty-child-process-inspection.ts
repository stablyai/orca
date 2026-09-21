/**
 * Whether anything is running under a pane's shell.
 *
 * Split out of `pty-shell-utils` because it is a distinct question from "what is in front" and
 * carries its own platform reasoning, its own cost budget, and the verdict vocabulary from
 * docs/reference/ssh-execution-boundary.md.
 */
import { queryWindowsPaneProcessInventory } from '../main/providers/windows-foreground-process-rows'
import { getProcessTableIndex } from '../shared/process-table-index'
import {
  getFreshProcessTableSnapshot,
  getProcessTableSnapshot
} from '../shared/process-table-snapshot-reader'
import type { PtyChildProcessVerdict } from '../shared/terminal-process-inspection'
import { isProcessAlive } from './pty-shell-utils'

/**
 * Check whether a process has child processes.
 *
 * Why the shared snapshot and not `pgrep -P`: this answers one field of
 * `pty.inspectProcess`, which every tracked pane polls on a 750ms/2000ms
 * cadence, and the fork was neither cached nor coalesced. procps-ng opens six
 * procfs files per process to resolve a ppid — including a `/proc/<pid>/ctty`
 * that never exists on Linux — so one call cost O(host process count) syscalls,
 * ~4k opens per pgrep on a 690-process host, at up to 8 forks/sec (#13537).
 * `getForegroundProcessName` in the same RPC already captured the TTL-cached
 * `ps` table, whose index carries the parent/child map, so the answer is free.
 *
 * `fresh` opts out of that TTL. A poll can read a 500ms-old table because its
 * next tick corrects it, but a close or cleanup decision acts on the answer
 * once and destructively — a child that started inside the TTL would be killed
 * with no confirmation. `pgrep` scanned per call, so anything that decides
 * has to keep scanning per call.
 */
export async function inspectPtyChildProcesses(
  pid: number,
  options?: { fresh?: boolean }
): Promise<PtyChildProcessVerdict> {
  if (process.platform === 'win32') {
    // Windows has no `ps`, but it does have a process table, and the pane walk over it already
    // exists for the foreground reader. Answering `false` from nothing was the older shape: a
    // hardcoded negative is indistinguishable from a measurement, and every close guard reads it
    // as "nothing is running here".
    //
    // Deliberately the TTL-cached table even when `fresh` is asked for: on a relay without the
    // native binding this falls back to the CIM scan, whose own 1.36s runtime is longer than the
    // 500ms TTL a fresh read would be refreshing, so a "fresh" answer is not meaningfully fresher
    // while N sequential ones are an N x 1.36s stall.
    const inventory = await queryWindowsPaneProcessInventory(pid)
    if (inventory) {
      return inventory.candidates.length > 0 ? 'children' : 'no-children'
    }
    // A null inventory is an unreadable table OR a snapshot that never showed the root, and
    // neither of those looked at the pane. The one answer available without the table is a root
    // the kernel says is gone: nothing runs under a shell that does not exist.
    return isProcessAlive(pid) ? 'unverifiable' : 'no-children'
  }
  try {
    const rows = options?.fresh
      ? await getFreshProcessTableSnapshot()
      : await getProcessTableSnapshot()
    return (getProcessTableIndex(rows).childrenByPpid.get(pid)?.length ?? 0) > 0
      ? 'children'
      : 'no-children'
  } catch {
    return 'unverifiable'
  }
}

/**
 * The boolean the wire has always carried. `unverifiable` keeps spelling itself `false` here on
 * purpose: this value reaches clients too old to know the third answer, and it is read both as
 * "busy, do not close" and as "the agent has taken over, safe to type into", so no single mapping
 * of `unverifiable` is safe for both. Callers that can act on the distinction read the verdict.
 */
export async function processHasChildren(
  pid: number,
  options?: { fresh?: boolean }
): Promise<boolean> {
  return (await inspectPtyChildProcesses(pid, options)) === 'children'
}
