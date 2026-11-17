import type { CommandSpec } from '../discovery/command-spec'
import { LOCAL_COMMAND_FLAGS } from '../arguments/args'

export const UNINSTALL_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['uninstall'],
    destructive: true,
    summary: 'Remove what Orca added outside its own folders before you delete the app',
    usage: 'orca uninstall [--yes] [--json]',
    allowedFlags: [...LOCAL_COMMAND_FLAGS, 'yes'],
    notes: [
      'Removes agent status hooks, the orca command on PATH, the orca serve background service and ~/.orca/agent-hooks. Projects, worktrees, chat history and Orca settings stay.',
      'Hooks shared with another installed Orca build stay. Asks before changing anything unless --yes is passed.',
      'Run it on each SSH host the Orca app could not reach.'
    ],
    examples: ['orca uninstall', 'orca uninstall --yes --json']
  }
]
