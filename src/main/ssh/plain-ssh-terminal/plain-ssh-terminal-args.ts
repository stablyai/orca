/**
 * argv for an interactive, unmanaged `ssh` login to a saved target. Only the target's identity is
 * shared with Orca's transport: no `-T`, no BatchMode and no Orca ControlMaster, so OpenSSH
 * allocates a TTY, prompts for passphrases, OTPs and host keys in the terminal, and applies the
 * user's own ssh_config (Include, Match, ProxyJump, ControlMaster) to the saved alias.
 */
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
