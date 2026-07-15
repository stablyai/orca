import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import { PTY_SESSION_COMMAND_TIMEOUT_MS } from '../shared/terminal-teardown-timeouts'
import { type PtyProcessSignaler, verifyProcessesStopped } from './pty-session-exit-verification'
import {
  frozenMembersStillOwnPty,
  isEmptyProcessSelection,
  listPtyMembers,
  parseCanonicalProcessId,
  parseCanonicalProcessIds,
  type PtySessionCommandRunner,
  rootStillOwnsPty
} from './pty-session-membership'

export {
  PTY_SESSION_COMMAND_TIMEOUT_MS,
  PTY_SESSION_VERIFY_TIMEOUT_MS
} from '../shared/terminal-teardown-timeouts'

type ExecFile = PtySessionCommandRunner
type KillProcess = PtyProcessSignaler

const execFile = promisify(execFileCallback) as ExecFile
export const MAX_PTY_PROCESS_TREE_SIZE = 1024
const VERIFY_PID_BATCH_SIZE = 64
const PARENT_PID_BATCH_SIZE = 64

export async function killPosixPtySession(
  pid: number,
  ptsName: unknown,
  platform: NodeJS.Platform = process.platform,
  run: ExecFile = execFile,
  killProcess: KillProcess = process.kill
): Promise<boolean> {
  if ((platform !== 'linux' && platform !== 'darwin') || !Number.isSafeInteger(pid) || pid <= 0) {
    return false
  }

  const stopped = new Set<number>()
  try {
    if (!(await rootStillOwnsPty(pid, ptsName, platform, run))) {
      return false
    }
    if (!stopProcess(pid, stopped, killProcess)) {
      return false
    }
    // Why: the PID can exit and be reused between the ownership probe and
    // SIGSTOP. Re-prove the frozen root before discovering or signaling children.
    if (!(await rootStillOwnsPty(pid, ptsName, platform, run))) {
      resumeProcesses(stopped, killProcess)
      return false
    }
    const processTree = await freezeProcessTree(pid, ptsName, platform, stopped, run, killProcess)
    if (!processTree) {
      resumeProcesses(stopped, killProcess)
      return false
    }
    // Why: remote relays support Node 18, which predates Array#toReversed.
    for (let index = processTree.length - 1; index >= 0; index -= 1) {
      const candidate = processTree[index]!
      if (!signalProcess(candidate, 'SIGKILL', killProcess)) {
        resumeProcesses(stopped, killProcess)
        return false
      }
      stopped.delete(candidate)
    }
    return await verifyProcessesStopped(processTree, run, killProcess)
  } catch {
    resumeProcesses(stopped, killProcess)
    return false
  }
}

async function freezeProcessTree(
  rootPid: number,
  ptsName: unknown,
  platform: NodeJS.Platform,
  stopped: Set<number>,
  run: ExecFile,
  killProcess: KillProcess
): Promise<number[] | null> {
  const processTree = [rootPid]
  const seen = new Set(processTree)
  let frontier = [rootPid]
  const discoveryDeadline = Date.now() + PTY_SESSION_COMMAND_TIMEOUT_MS
  while (true) {
    while (frontier.length > 0) {
      const nextFrontier: number[] = []
      for (let index = 0; index < frontier.length; index += PARENT_PID_BATCH_SIZE) {
        const remainingMs = discoveryDeadline - Date.now()
        if (remainingMs <= 0) {
          return null
        }
        const parents = frontier.slice(index, index + PARENT_PID_BATCH_SIZE)
        const children = await listChildren(parents, run, remainingMs)
        const newlyStopped: number[] = []
        for (const child of children) {
          if (seen.has(child)) {
            continue
          }
          if (seen.size >= MAX_PTY_PROCESS_TREE_SIZE) {
            return null
          }
          seen.add(child)
          if (!stopProcess(child, stopped, killProcess)) {
            return null
          }
          newlyStopped.push(child)
        }
        const childVerificationRemainingMs = discoveryDeadline - Date.now()
        if (
          newlyStopped.length > 0 &&
          (childVerificationRemainingMs <= 0 ||
            !(await frozenChildrenStillBelongToParents(
              newlyStopped,
              parents,
              run,
              childVerificationRemainingMs
            )))
        ) {
          return null
        }
        for (const child of newlyStopped) {
          processTree.push(child)
          nextFrontier.push(child)
        }
      }
      frontier = nextFrontier
    }

    const remainingMs = discoveryDeadline - Date.now()
    if (remainingMs <= 0) {
      return null
    }
    const members = await listPtyMembers(rootPid, ptsName, platform, run, remainingMs)
    if (!members.includes(rootPid)) {
      // Why: the frozen, revalidated root must appear in its targeted SID/TTY
      // inventory; absence means the selection cannot certify completeness.
      return null
    }
    const newlyStoppedMembers: number[] = []
    for (const member of members) {
      if (seen.has(member)) {
        continue
      }
      if (seen.size >= MAX_PTY_PROCESS_TREE_SIZE) {
        return null
      }
      seen.add(member)
      if (!stopProcess(member, stopped, killProcess)) {
        return null
      }
      newlyStoppedMembers.push(member)
    }
    if (newlyStoppedMembers.length === 0) {
      return processTree
    }
    const memberVerificationRemainingMs = discoveryDeadline - Date.now()
    if (
      memberVerificationRemainingMs <= 0 ||
      !(await frozenMembersStillOwnPty(
        newlyStoppedMembers,
        rootPid,
        ptsName,
        platform,
        run,
        memberVerificationRemainingMs
      ))
    ) {
      return null
    }
    // Why: an intermediate shell can exit before teardown, reparenting a
    // background job outside the root PPID tree while it still owns this PTY.
    processTree.push(...newlyStoppedMembers)
    frontier = newlyStoppedMembers
  }
}

async function listChildren(
  parentPids: readonly number[],
  run: ExecFile,
  timeout: number
): Promise<number[]> {
  try {
    const result = (await run('pgrep', ['-P', parentPids.join(',')], {
      timeout
    })) as { stdout?: string | Buffer }
    return parseCanonicalProcessIds(result.stdout)
  } catch (error) {
    if (isEmptyProcessSelection(error)) {
      return []
    }
    throw error
  }
}

async function frozenChildrenStillBelongToParents(
  childPids: readonly number[],
  parentPids: readonly number[],
  run: ExecFile,
  timeout: number
): Promise<boolean> {
  const expectedParents = new Set(parentPids)
  const verifiedChildren = new Set<number>()
  const verificationDeadline = Date.now() + timeout
  for (let index = 0; index < childPids.length; index += VERIFY_PID_BATCH_SIZE) {
    const remainingMs = verificationDeadline - Date.now()
    if (remainingMs <= 0) {
      return false
    }
    const batch = childPids.slice(index, index + VERIFY_PID_BATCH_SIZE)
    const result = (await run('ps', ['-p', batch.join(','), '-o', 'pid=', '-o', 'ppid='], {
      timeout: remainingMs
    })) as { stdout?: string | Buffer }
    for (const line of String(result.stdout ?? '')
      .trim()
      .split('\n')) {
      const columns = line.trim().split(/\s+/)
      const [pidText, parentPidText] = columns
      const pid = parseCanonicalProcessId(pidText)
      const parentPid = parseCanonicalProcessId(parentPidText)
      if (
        columns.length !== 2 ||
        pid === null ||
        parentPid === null ||
        !batch.includes(pid) ||
        !expectedParents.has(parentPid) ||
        verifiedChildren.has(pid)
      ) {
        return false
      }
      verifiedChildren.add(pid)
    }
  }
  return verifiedChildren.size === childPids.length
}

function stopProcess(pid: number, stopped: Set<number>, killProcess: KillProcess): boolean {
  try {
    killProcess(pid, 'SIGSTOP')
    stopped.add(pid)
    return true
  } catch {
    return false
  }
}

function signalProcess(pid: number, signal: NodeJS.Signals, killProcess: KillProcess): boolean {
  try {
    killProcess(pid, signal)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

function resumeProcesses(stopped: Set<number>, killProcess: KillProcess): void {
  for (const pid of stopped) {
    signalProcess(pid, 'SIGCONT', killProcess)
  }
  stopped.clear()
}
