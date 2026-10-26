import { quotePosixShell } from '../../shared/shell-argument-quoting'
import { buildAnyShellStdoutFence } from '../../shared/posix-stdout-fence'

const COMMAND_ONLY_SHELLS = new Set(['sh', 'dash', 'csh', 'tcsh'])

type SshLoginShellCommand = {
  command: string
  /** The payload's own stdout, or null when the login shell never ran it. */
  readStdout: (stdout: string) => string | null
}

export function buildSshLoginShellCommand(shell: string, command: string): SshLoginShellCommand {
  const shellName = shell.split('/').at(-1)
  // csh/tcsh reject -lc; sh/dash do not need login mode for this probe.
  const mode = shellName && COMMAND_ONLY_SHELLS.has(shellName) ? '-c' : '-lc'
  // Fence inside the login shell because both it and sshd's outer shell may print startup noise.
  const fence = buildAnyShellStdoutFence(command, 'SSH_LOGIN')
  return {
    command: `${quotePosixShell(shell)} ${mode} ${quotePosixShell(fence.command)}`,
    readStdout: fence.readStdout
  }
}
