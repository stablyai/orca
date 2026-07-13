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
    return await verifyProcessesStopped(processTree, platform, run)
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
  const sessionColumn = platform === 'darwin' ? 'sess=' : 'sid='
  const result = (await run('/bin/ps', ['-p', String(pid), '-o', sessionColumn, '-o', 'tty='], {
    timeout: PTY_SESSION_COMMAND_TIMEOUT_MS
  })) as { stdout?: string | Buffer }
  const [sidText, tty = ''] = String(result.stdout ?? '')
    .trim()
    .split(/\s+/)
  if (Number(sidText) !== pid) {
    return false
  }
  if (typeof ptsName !== 'string') {
    // Why: some node-pty builds omit the private ptsName field. The
    // session-leader check plus a real controlling TTY still proves ownership.
    return tty.length > 0 && tty !== '??' && tty !== '?'
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
      for (const child of await listChildren(parents, run, remainingMs)) {
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
    const result = (await run('/usr/bin/pgrep', ['-P', parentPids.join(',')], {
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

async function verifyProcessesStopped(
  pids: number[],
  platform: NodeJS.Platform,
  run: ExecFile
): Promise<boolean> {
  const batchSize = platform === 'darwin' ? 1 : VERIFY_PID_BATCH_SIZE
  for (let index = 0; index < pids.length; index += batchSize) {
    const batch = pids.slice(index, index + batchSize)
    try {
      const pidSelector = platform === 'darwin' ? String(batch[0]) : batch.join(',')
      const result = (await run('/bin/ps', ['-p', pidSelector, '-o', 'pid=', '-o', 'stat='], {
        timeout: PTY_SESSION_VERIFY_TIMEOUT_MS
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
