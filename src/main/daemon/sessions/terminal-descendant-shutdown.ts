import * as descendantTermination from '../../pty/process-retirement/pty-descendant-termination'
import type { ProcessTableReader } from '../../pty/process-retirement/pty-descendant-fresh-table'
import type { DescendantSnapshot } from '../../pty/process-retirement/pty-descendant-termination'
import {
  terminateDescendantSnapshotWithVerdict,
  type DescendantTreeVerdict
} from '../../pty/process-retirement/pty-descendant-exit-verification'
import { readTerminalPs } from '../../pty/process-retirement/terminal-process-rows'
import { executableName } from '../pty-subprocess/spawn-file-child-processes'
import { isShellProcess } from '../../../shared/agent-status/process/shell-process-detection'
import {
  SHUTDOWN_DESCENDANT_TABLE_TIMEOUT_MS,
  SHUTDOWN_DESCENDANT_VERIFY_MS
} from './immediate-kill-reply-budget'

// Share in-flight shutdown scans and retain results for 25ms to limit process-table fanout.
let sharedShutdownCapture: {
  promise: ReturnType<ProcessTableReader>
  expires?: ReturnType<typeof setTimeout>
} | null = null

const readShutdownProcessTable: ProcessTableReader = (timeoutMs) => {
  if (sharedShutdownCapture) {
    return sharedShutdownCapture.promise
  }
  const promise = descendantTermination.readProcessTable(timeoutMs)
  sharedShutdownCapture = { promise }
  const clear = (): void => {
    if (sharedShutdownCapture?.promise === promise) {
      sharedShutdownCapture = null
    }
  }
  void promise.then(() => {
    const expires = setTimeout(clear, 25)
    expires.unref?.()
    if (sharedShutdownCapture?.promise === promise) {
      sharedShutdownCapture.expires = expires
    }
  }, clear)
  return promise
}
// Wrapping the production reader keeps its in-process allowance, so a stalled native read still leaves ps the whole window.
readShutdownProcessTable.deadlineAllowanceMs = (timeoutMs) =>
  descendantTermination.readProcessTable.deadlineAllowanceMs?.(timeoutMs) ?? 0

const LOGIN_SHELL_FLAG = /^(?:-[il]+|--login)$/

/** Only a bare idle shell alone under login(1) ignores SIGTERM; scripts and -c commands keep the grace for TERM traps. */
async function findLoneLoginShellPid(snapshot: DescendantSnapshot): Promise<number | undefined> {
  const [child, ...others] = snapshot.descendants
  if (!child || others.length > 0) {
    return undefined
  }
  const command = await readTerminalPs(
    ['-ww', '-o', 'command=', '-p', String(child.pid)],
    SHUTDOWN_DESCENDANT_TABLE_TIMEOUT_MS
  )
  const [argv0, ...args] = command?.trim().split(/\s+/) ?? []
  const isBareShell =
    argv0 !== undefined &&
    isShellProcess(executableName(argv0)) &&
    args.every((arg) => LOGIN_SHELL_FLAG.test(arg))
  return isBareShell ? child.pid : undefined
}

export async function terminateShutdownDescendants(
  snapshot: DescendantSnapshot,
  shellIsRootChild: boolean
): Promise<DescendantTreeVerdict> {
  if (snapshot.descendants.length === 0) {
    return 'exited'
  }
  return terminateDescendantSnapshotWithVerdict(snapshot, {
    verifyMs: SHUTDOWN_DESCENDANT_VERIFY_MS,
    timeoutMs: SHUTDOWN_DESCENDANT_TABLE_TIMEOUT_MS,
    keepAlive: true,
    requireIdentityBeforeSignal: true,
    readTable: readShutdownProcessTable,
    shellPid: shellIsRootChild ? await findLoneLoginShellPid(snapshot) : undefined
  })
}

const PROCESS_GROUP_DRAIN_MS = 1_500
const PROCESS_GROUP_POLL_MS = 100

/**
 * After a teardown, whether any live process remains in the session's captured process groups.
 * Children forked after the descendant scan keep their parent's group, so this catches them; a
 * short-lived straggler may finish within the drain window. A process that started a new session
 * left the tree on purpose. An unreadable table proves nothing.
 */
export async function shutdownProcessGroupsStillLive(
  processGroups: ReadonlySet<number>,
  drainMs = PROCESS_GROUP_DRAIN_MS
): Promise<boolean | 'unknown'> {
  const deadline = Date.now() + drainMs
  for (;;) {
    let capture: Awaited<ReturnType<ProcessTableReader>>
    try {
      capture = await descendantTermination.readProcessTable(SHUTDOWN_DESCENDANT_TABLE_TIMEOUT_MS)
    } catch {
      return 'unknown'
    }
    if (!capture.rows.some((row) => processGroups.has(row.pgid) && !row.zombie)) {
      return false
    }
    if (Date.now() >= deadline) {
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, PROCESS_GROUP_POLL_MS))
  }
}
