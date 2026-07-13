import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'

type ExecFile = (file: string, args: string[], options: { timeout: number }) => Promise<unknown>

const execFile = promisify(execFileCallback) as ExecFile

export async function killPosixPtySession(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  run: ExecFile = execFile
): Promise<boolean> {
  if (platform === 'win32' || !Number.isSafeInteger(pid) || pid <= 0) {
    return false
  }

  try {
    // Why: forkpty makes the shell a session leader. Killing by SID also reaps
    // background job groups that a direct node-pty SIGKILL would orphan.
    await run('pkill', ['-KILL', '-s', String(pid)], { timeout: 3000 })
    return true
  } catch {
    // Missing pkill and an already-empty session both fall back to node-pty.
    return false
  }
}
