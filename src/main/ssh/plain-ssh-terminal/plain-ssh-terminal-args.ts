/** Keep interactive OpenSSH login unmanaged: omit -T, BatchMode and Orca ControlMaster so the saved alias uses user ssh_config and terminal prompts/TTY. */
import type { SshTarget } from '../../../shared/ssh-types'
import {
  appendSshTargetDestinationArgs,
  type SystemSshBuildArgsOptions
} from '../system-transport/system-ssh-args'

export function buildPlainSshTerminalArgs(
  target: SshTarget,
  options?: Pick<SystemSshBuildArgsOptions, 'aliasClaimedByConfig'>
): string[] {
  const args: string[] = []
  appendSshTargetDestinationArgs(args, target, options)
  return args
}
