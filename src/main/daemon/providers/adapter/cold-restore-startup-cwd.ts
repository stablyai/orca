import { probeRecoveredStartupCwdDirectory } from '../../../ipc/pty/host-env/startup-cwd-directory-exists'
import { isUnsafeAgentStartupCwd } from '../../../providers/working-directory/default-cwd'

/** The folder a cold-restored pane starts in: its recovered folder unless proven missing or unsafe for its agent. */
export async function resolveColdRestoreStartupCwd(args: {
  recoveredCwd: string | undefined
  requestedCwd: string
  command: string | undefined
}): Promise<string> {
  const { recoveredCwd, requestedCwd } = args
  // The resume command was planned for the requested folder; a shell last seen at a root must not move the agent there.
  if (!recoveredCwd || isUnsafeAgentStartupCwd(recoveredCwd, args.command)) {
    return requestedCwd
  }
  // Why one probe for WSL too: a stat over \\wsl.localhost waits for a stopped distro and
  // fails for reasons other than absence, which woke panes blank and at the root.
  return (await probeRecoveredStartupCwdDirectory(recoveredCwd)) === false
    ? requestedCwd
    : recoveredCwd
}
