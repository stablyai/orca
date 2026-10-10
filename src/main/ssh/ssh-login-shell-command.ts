import { shellEscape } from './ssh-connection-utils'
import { buildAnyShellStdoutFence } from '../../shared/posix-stdout-fence'

const COMMAND_ONLY_SHELLS = new Set(['sh', 'dash', 'csh', 'tcsh'])

export type SshLoginShellCommand = {
  command: string
  /** The payload's own stdout, or null when the login shell never ran it. */
  readStdout: (stdout: string) => string | null
}

/** Build a command using the startup mode supported by the configured login shell. */
export function buildSshLoginShellCommand(shell: string, command: string): SshLoginShellCommand {
  const shellName = shell.split('/').at(-1)
  // Why: csh/tcsh reject combined -lc, while sh/dash do not need login mode here.
  const mode = shellName && COMMAND_ONLY_SHELLS.has(shellName) ? '-c' : '-lc'
  // Why inside the login shell: both sshd's shell and this one read startup files that can print.
  const fence = buildAnyShellStdoutFence(command, 'SSH_LOGIN')
  return {
    command: `${shellEscape(shell)} ${mode} ${shellEscape(fence.command)}`,
    readStdout: fence.readStdout
  }
}
