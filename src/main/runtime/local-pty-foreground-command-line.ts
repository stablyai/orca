import { listRegisteredPtys } from '../memory/pty-registry'
import { resolveAgentForegroundCommandLine } from '../providers/agent-foreground-process'
import { resolveWindowsAgentForegroundCommandLine } from '../providers/windows-agent-foreground-command-line'

/** Command line of a local PTY's foreground agent, read from this host's process table. */
export async function readLocalPtyForegroundCommandLine(
  ptyId: string,
  foregroundProcess: string
): Promise<string | null> {
  const shellPid = listRegisteredPtys().find((pty) => pty.ptyId === ptyId)?.pid
  if (!shellPid) {
    return null
  }
  return process.platform === 'win32'
    ? resolveWindowsAgentForegroundCommandLine(shellPid, foregroundProcess)
    : resolveAgentForegroundCommandLine(shellPid)
}
