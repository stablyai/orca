import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'

type ExecFile = (file: string, args: string[], options: { timeout: number }) => Promise<unknown>
type KillProcess = (pid: number, signal: NodeJS.Signals) => void

const execFile = promisify(execFileCallback) as ExecFile
export const PTY_SESSION_COMMAND_TIMEOUT_MS = 2500
export const PTY_SESSION_VERIFY_TIMEOUT_MS = 500

export async function killPosixPtySession(
  pid: number,
  ptsName: unknown,
  platform: NodeJS.Platform = process.platform,
  run: ExecFile = execFile,
  killProcess: KillProcess = process.kill
): Promise<boolean> {
  if (platform === 'win32' || !Number.isSafeInteger(pid) || pid <= 0) {
    return false
  }

  try {
    if (platform === 'linux') {
      // Why: forkpty makes the Linux shell a session leader. SID targeting
      // includes background job groups without a broad process inventory.
      try {
        await run('pkill', ['-KILL', '-s', String(pid), '.*'], {
          timeout: PTY_SESSION_COMMAND_TIMEOUT_MS
        })
      } catch (error) {
        if (!isEmptyProcessSelection(error)) {
          throw error
        }
      }
      return await verifyLinuxSessionStopped(pid, run)
    }
    if (platform === 'darwin') {
      return await killDarwinPtyProcesses(pid, ptsName, run, killProcess)
    }
    return false
  } catch {
    // Missing platform tools and already-empty sessions fall back to node-pty.
    return false
  }
}

async function killDarwinPtyProcesses(
  rootPid: number,
  ptsName: unknown,
  run: ExecFile,
  killProcess: KillProcess
): Promise<boolean> {
  if (typeof ptsName !== 'string') {
    return false
  }
  const tty = ptsName.startsWith('/dev/') ? ptsName.slice('/dev/'.length) : ptsName
  if (!/^[A-Za-z0-9._-]+$/.test(tty)) {
    return false
  }
  // Why: Darwin pkill has no SID selector and its TTY filter does not match
  // forkpty children. A targeted ps query avoids a system-wide inventory.
  const result = (await run('/bin/ps', ['-t', tty, '-o', 'pid=', '-o', 'ppid='], {
    timeout: PTY_SESSION_COMMAND_TIMEOUT_MS
  })) as {
    stdout?: string | Buffer
  }
  const rows = String(result.stdout ?? '')
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(
      (row): row is [number, number] =>
        row.length === 2 &&
        row.every((candidate) => Number.isSafeInteger(candidate) && candidate >= 0) &&
        row[0] > 0
    )
  if (!rows.some(([candidate]) => candidate === rootPid)) {
    return false
  }
  const parentByPid = new Map(rows)
  const depth = (pid: number): number => {
    let current = pid
    let result = 0
    const visited = new Set<number>()
    while (current !== rootPid && !visited.has(current)) {
      visited.add(current)
      const parent = parentByPid.get(current)
      if (!parent || !parentByPid.has(parent)) {
        break
      }
      current = parent
      result += 1
    }
    return result
  }
  // Why: descendants must be signalled before their parents so the snapshot
  // cannot be invalidated by reparenting while teardown is in progress.
  const pids = rows
    .map(([candidate]) => candidate)
    .sort((a, b) => {
      if (a === rootPid) {
        return 1
      }
      if (b === rootPid) {
        return -1
      }
      return depth(b) - depth(a)
    })
  for (const candidate of pids) {
    try {
      killProcess(candidate, 'SIGKILL')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        return false
      }
    }
  }
  return await verifyDarwinTtyStopped(tty, run)
}

async function verifyLinuxSessionStopped(pid: number, run: ExecFile): Promise<boolean> {
  try {
    const result = (await run('/bin/ps', ['-s', String(pid), '-o', 'stat='], {
      timeout: PTY_SESSION_VERIFY_TIMEOUT_MS
    })) as { stdout?: string | Buffer }
    return hasOnlyExitedProcesses(result.stdout)
  } catch (error) {
    return isEmptyProcessSelection(error)
  }
}

async function verifyDarwinTtyStopped(tty: string, run: ExecFile): Promise<boolean> {
  try {
    const result = (await run('/bin/ps', ['-t', tty, '-o', 'pid=', '-o', 'stat='], {
      timeout: PTY_SESSION_VERIFY_TIMEOUT_MS
    })) as { stdout?: string | Buffer }
    return hasOnlyExitedProcesses(result.stdout, true)
  } catch (error) {
    return isEmptyProcessSelection(error)
  }
}

function hasOnlyExitedProcesses(stdout: string | Buffer | undefined, pidColumn = false): boolean {
  const lines = String(stdout ?? '')
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  return lines.every((line) => {
    const stat = pidColumn ? line.split(/\s+/).at(-1) : line
    return stat?.startsWith('Z') === true
  })
}

function isEmptyProcessSelection(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false
  }
  const processError = error as { code?: unknown; stdout?: unknown }
  // Why: BSD/procps ps exits 1 for an empty selector. Only that exact empty
  // result proves absence; ENOENT, timeout, and malformed output fail closed.
  return processError.code === 1 && String(processError.stdout ?? '').trim() === ''
}
