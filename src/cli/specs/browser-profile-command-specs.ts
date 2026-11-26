import type { CommandSpec } from '../discovery/command-spec'
import { CLI_GLOBAL_FLAGS as GLOBAL_FLAGS } from '../../shared/cli/cli-argument-boundary'

export const BROWSER_PROFILE_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['tab', 'profile', 'list'],
    summary: 'List browser session profiles available to browser tabs',
    usage: 'orca tab profile list [--json]',
    allowedFlags: [...GLOBAL_FLAGS]
  },
  {
    path: ['tab', 'profile', 'create'],
    summary: 'Create a browser session profile for browser tabs',
    usage: 'orca tab profile create --label <name> [--scope <isolated|imported>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'label', 'scope']
  },
  {
    path: ['tab', 'profile', 'rename'],
    summary: 'Rename a browser session profile',
    usage: 'orca tab profile rename --profile <id> --label <name> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'profile', 'label']
  },
  {
    path: ['tab', 'profile', 'delete'],
    destructive: true,
    summary: 'Delete a browser session profile used by browser tabs',
    usage: 'orca tab profile delete --profile <id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'profile']
  },
  {
    path: ['tab', 'profile', 'set'],
    summary: 'Switch a browser tab to a different browser profile',
    usage: 'orca tab profile set (--page <id> | --worktree <selector>) --profile <id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'profile', 'page', 'worktree']
  },
  {
    path: ['tab', 'profile', 'show'],
    summary: 'Show the browser profile bound to a tab',
    usage: 'orca tab profile show --page <id> [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'page', 'worktree']
  },
  {
    path: ['tab', 'profile', 'use-default'],
    summary: 'Switch a browser tab back to the default browser profile',
    usage: 'orca tab profile use-default --page <id> [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'page', 'worktree']
  },
  {
    path: ['tab', 'profile', 'clone'],
    summary: 'Clone a browser tab into a different browser profile',
    usage: 'orca tab profile clone --profile <id> [--page <id>] [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'profile', 'page', 'worktree']
  }
]
