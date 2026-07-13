import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'

type ExecFile = (file: string, args: string[], options: { timeout: number }) => Promise<unknown>
type KillProcess = (pid: number, signal: NodeJS.Signals) => void

const execFile = promisify(execFileCallback) as ExecFile
export const PTY_SESSION_COMMAND_TIMEOUT_MS = 2500
export const PTY_SESSION_VERIFY_TIMEOUT_MS = 500
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
    const processTree = await freezeProcessTree(pid, stopped, run, killProcess)
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
    return await verifyProcessesStopped(processTree, run)
  } catch {
    resumeProcesses(stopped, killProcess)
    return false
  }
}

async function rootStillOwnsPty(
  pid: number,
  ptsName: unknown,
  platform: NodeJS.Platform,
  run: ExecFile
): Promise<boolean> {
  if (typeof ptsName !== 'string') {
    // Why: without the exact controlling TTY, a recycled session-leader PID
    // is not enough authority to signal an unrelated user's process tree.
    return false
  }
  const ownerColumn = platform === 'darwin' ? 'pgid=' : 'sid='
  const result = (await run('ps', ['-p', String(pid), '-o', ownerColumn, '-o', 'tty='], {
    timeout: PTY_SESSION_COMMAND_TIMEOUT_MS
  })) as { stdout?: string | Buffer }
  const [ownerText, tty = ''] = String(result.stdout ?? '')
    .trim()
    .split(/\s+/)
  if (Number(ownerText) !== pid) {
    return false
  }
  const expectedTty = ptsName.startsWith('/dev/') ? ptsName.slice('/dev/'.length) : ptsName
  return /^[A-Za-z0-9._/-]+$/.test(expectedTty) && tty === expectedTty
}

async function freezeProcessTree(
  rootPid: number,
  stopped: Set<number>,
  run: ExecFile,
  killProcess: KillProcess
): Promise<number[] | null> {
  const processTree = [rootPid]
  const seen = new Set(processTree)
  let frontier = [rootPid]
  const discoveryDeadline = Date.now() + PTY_SESSION_COMMAND_TIMEOUT_MS
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
  return processTree
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
    return String(result.stdout ?? '')
      .trim()
      .split(/\s+/)
      .map(Number)
      .filter((candidate) => Number.isSafeInteger(candidate) && candidate > 0)
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
      const [pidText, parentPidText] = line.trim().split(/\s+/)
      const pid = Number(pidText)
      const parentPid = Number(parentPidText)
      if (!batch.includes(pid) || !expectedParents.has(parentPid) || verifiedChildren.has(pid)) {
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

async function verifyProcessesStopped(pids: number[], run: ExecFile): Promise<boolean> {
  const verificationDeadline = Date.now() + PTY_SESSION_VERIFY_TIMEOUT_MS
  for (let index = 0; index < pids.length; index += VERIFY_PID_BATCH_SIZE) {
    const remainingMs = verificationDeadline - Date.now()
    if (remainingMs <= 0) {
      return false
    }
    const batch = pids.slice(index, index + VERIFY_PID_BATCH_SIZE)
    try {
      const result = (await run('ps', ['-p', batch.join(','), '-o', 'pid=', '-o', 'stat='], {
        timeout: remainingMs
      })) as { stdout?: string | Buffer }
      if (!hasOnlyExitedProcesses(result.stdout)) {
        return false
      }
    } catch (error) {
      if (!isEmptyProcessSelection(error)) {
        return false
      }
    }
  }
  return true
}

function hasOnlyExitedProcesses(stdout: string | Buffer | undefined): boolean {
  return String(stdout ?? '')
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .every((line) => line.split(/\s+/).at(-1)?.startsWith('Z') === true)
}

function isEmptyProcessSelection(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false
  }
  const processError = error as { code?: unknown; stdout?: unknown }
  // Why: BSD/procps ps/pgrep exit 1 for an empty selector. Only that exact
  // empty result proves absence; ENOENT, timeout, and malformed output fail closed.
  return processError.code === 1 && String(processError.stdout ?? '').trim() === ''
}
