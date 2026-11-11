import type * as pty from 'node-pty'
import { ptyShellProcessId } from '../../windows/windows-pty-job'
import { confirmShellForegroundProcess } from '../../providers/agent-foreground-process'
import { readWindowsPtyJobProcessIds } from '../../providers/windows-pty-job-membership'

/** Require fresh execution-host inspection; cached foreground state is insufficient. */
export async function confirmPtyShellForeground(args: {
  process: pty.IPty
  shellPath: string | undefined
  isDead: () => boolean
}): Promise<boolean> {
  if (args.isDead() || !args.process.pid) {
    return false
  }
  const confirmed = await confirmShellForegroundProcess(
    ptyShellProcessId(args.process),
    args.shellPath,
    process.platform === 'win32'
      ? { readWindowsPtyJobProcessIds: () => readWindowsPtyJobProcessIds(args.process) }
      : {}
  )
  return !args.isDead() && confirmed
}
