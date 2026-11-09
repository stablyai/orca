import type { CommandSpec } from '../args'
import { LOCAL_COMMAND_FLAGS } from '../args'

export const CLOUD_SSH_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['ssh'],
    summary: 'Open an SSH session in an Orca Cloud workspace, waking it if it sleeps',
    usage: 'orca ssh <workspace> [--command <command>] [--print]',
    allowedFlags: [...LOCAL_COMMAND_FLAGS, 'workspace', 'command', 'print'],
    positionalArgs: ['workspace'],
    notes: [
      '<workspace> is the workspace name, its SSH host name (orca-…), or its id.',
      'The first use creates a key for this computer and installs it in the workspace. Keys and the SSH config are Orca’s own files; ~/.ssh is not touched.',
      'Runs ssh with Orca’s config file (-F), so the session tunnels through `orca ssh-proxy` over Orca’s connection to the workspace. --print shows that ssh command instead of running it.',
      'Needs the Orca desktop app; it starts when it is not running.'
    ],
    examples: [
      'orca ssh "Fix login bug"',
      'orca ssh orca-fix-login-bug-1a2b --command "git status"'
    ]
  },
  {
    path: ['ssh-proxy'],
    summary: 'Carry one SSH connection to an Orca Cloud workspace (ssh ProxyCommand)',
    usage: 'orca ssh-proxy <workspace>',
    allowedFlags: [...LOCAL_COMMAND_FLAGS, 'workspace'],
    positionalArgs: ['workspace'],
    notes: [
      'Orca’s SSH config sets this as ProxyCommand; editors’ Remote-SSH run it too. It wakes the workspace, then pipes stdin and stdout to the workspace’s sshd.',
      'Writes only the SSH stream to stdout; errors go to stderr.'
    ],
    examples: ['orca ssh-proxy orca-fix-login-bug-1a2b']
  }
]
