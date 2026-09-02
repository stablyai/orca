import { shellEscape } from './ssh-connection-utils'

const COMMAND_ONLY_SHELLS = new Set(['sh', 'dash', 'csh', 'tcsh'])

/** Build a command using the startup mode supported by the configured login shell. */
export function buildSshLoginShellCommand(shell: string, command: string): string {
  const shellName = shell.split('/').at(-1)
  // Why: csh/tcsh reject combined -lc, while sh/dash do not need login mode here.
  const mode = shellName && COMMAND_ONLY_SHELLS.has(shellName) ? '-c' : '-lc'
  return `${shellEscape(shell)} ${mode} ${shellEscape(command)}`
}
