import type { ChildProcess } from 'node:child_process'
import { childProcessHasExited } from '@orca/process-host/process-tree-termination'
import {
  captureDescendantSnapshot,
  liveIdentityMatches,
  readProcessTable,
  readProcessTableBeforeDeadline,
  sendDescendantSignal
} from '../../pty/process-retirement/pty-descendant-termination'
import { DESCENDANT_SNAPSHOT_TIMEOUT_MS } from '../../pty/process-retirement/pty-descendant-fresh-table'
import type { ProcessTableRow } from '../../pty/process-retirement/pty-process-table-parser'
import { killProcess } from './system-ssh-operation-lifecycle'

const awaitingSnapshot = new Set<ChildProcess>()
let exitHookInstalled = false

// Orca can exit before a pending snapshot resolves; never drop the SIGTERM it owes.
function sigtermAwaitingSnapshotOnExit(): void {
  for (const proc of awaitingSnapshot) {
    killProcess(proc)
  }
}

/**
 * SIGTERM an Orca-owned system ssh. OpenSSH installs its SIGTERM handler only when the session starts, so a signal death
 * during connect/auth skips ssh_kill_proxy_command and orphans the ProxyCommand/ProxyJump child. Snapshot ssh's
 * descendants first and hang them up only after such a death: a handled exit already cleaned up, and a ControlPersist
 * master's proxy stays this ssh's child.
 */
export function terminateSystemSsh(proc: ChildProcess): void {
  if (childProcessHasExited(proc) || proc.killed || awaitingSnapshot.has(proc)) {
    return
  }
  const pid = proc.pid
  if (process.platform === 'win32' || !pid) {
    killProcess(proc)
    return
  }
  awaitingSnapshot.add(proc)
  if (!exitHookInstalled) {
    exitHookInstalled = true
    process.once('exit', sigtermAwaitingSnapshotOnExit)
  }
  void captureDescendantSnapshot(pid).then((snapshot) => {
    awaitingSnapshot.delete(proc)
    if (childProcessHasExited(proc)) {
      return
    }
    const descendants = snapshot?.descendants ?? []
    if (descendants.length > 0) {
      proc.once('exit', (_code, signal) => {
        if (signal !== null) {
          void hangUpOrphanedDescendants(descendants)
        }
      })
    }
    killProcess(proc)
  })
}

async function hangUpOrphanedDescendants(descendants: readonly ProcessTableRow[]): Promise<void> {
  const capture = await readProcessTableBeforeDeadline(
    readProcessTable,
    DESCENDANT_SNAPSHOT_TIMEOUT_MS
  )
  if (!capture) {
    return
  }
  for (const row of liveIdentityMatches(descendants, capture.rows)) {
    // OpenSSH's own proxy cleanup signal.
    sendDescendantSignal(row.pid, 'SIGHUP')
  }
}
