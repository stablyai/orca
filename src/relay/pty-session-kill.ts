import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'

type ExecFile = (file: string, args: string[], options: { timeout: number }) => Promise<unknown>
type KillProcess = (pid: number, signal: NodeJS.Signals) => void

const execFile = promisify(execFileCallback) as ExecFile

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
      await run('pkill', ['-KILL', '-s', String(pid), '.*'], { timeout: 3000 })
      return true
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
  const result = (await run('ps', ['-t', tty, '-o', 'pid='], { timeout: 3000 })) as {
    stdout?: string | Buffer
  }
  const pids = String(result.stdout ?? '')
    .split(/\s+/)
    .map(Number)
    .filter((candidate) => Number.isSafeInteger(candidate) && candidate > 0)
  if (!pids.includes(rootPid)) {
    return false
  }
  // Kill the leader last so its child job groups cannot be reparented between
  // the ownership snapshot and their signals.
  for (const candidate of [...pids.filter((entry) => entry !== rootPid), rootPid]) {
    try {
      killProcess(candidate, 'SIGKILL')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        return false
      }
    }
  }
  return true
}
