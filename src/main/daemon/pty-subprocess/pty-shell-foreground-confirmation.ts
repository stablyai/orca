import type * as pty from 'node-pty'
import { confirmShellForegroundProcess } from '../../providers/agent-foreground-process'
import { readWindowsPtyJobProcessIds } from '../../providers/windows-pty-job-membership'

/** Fresh execution-host proof that the spawned shell owns the PTY foreground:
 *  a post-request process inspection (POSIX `ps`, Windows job membership),
 *  never cached state. */
export async function confirmPtyShellForeground(args: {
  process: pty.IPty
  shellPath: string
  isDead: () => boolean
}): Promise<boolean> {
  if (args.isDead() || !args.process.pid) {
    return false
  }
  const confirmed = await confirmShellForegroundProcess(
    args.process.pid,
    args.shellPath,
    process.platform === 'win32'
      ? { readWindowsPtyJobProcessIds: () => readWindowsPtyJobProcessIds(args.process) }
      : {}
  )
  return !args.isDead() && confirmed
}
