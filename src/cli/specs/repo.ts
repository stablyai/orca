import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS, LOCAL_COMMAND_FLAGS } from '../args'

export const REPO_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['repo', 'list'],
    summary: 'List repos registered in Orca',
    usage: 'orca repo list [--json]',
    allowedFlags: [...GLOBAL_FLAGS]
  },
  {
    path: ['repo', 'add'],
    summary: 'Add a project to Orca by filesystem path',
    usage: 'orca repo add --path <path> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'path']
  },
  {
    path: ['repo', 'show'],
    summary: 'Show one registered repo',
    usage: 'orca repo show --repo <selector> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'repo']
  },
  {
    path: ['repo', 'set'],
    summary: 'Set whether non-Orca worktrees are shown for a repo',
    usage:
      'orca repo set --repo <selector> --external-worktree-visibility show|hide|inherit [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'repo', 'external-worktree-visibility'],
    notes: [
      'show and hide override the global non-Orca worktree visibility default for this repo; inherit clears the override.',
      'Per-worktree visibility rules still apply.'
    ],
    examples: ['orca repo set --repo path:/path/to/repo --external-worktree-visibility show --json']
  },
  {
    path: ['repo', 'set-base-ref'],
    summary: "Set the repo's default base ref for future worktrees",
    usage: 'orca repo set-base-ref --repo <selector> --ref <ref> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'repo', 'ref']
  },
  {
    path: ['repo', 'search-refs'],
    summary: 'Search branch/tag refs within a repo',
    usage: 'orca repo search-refs --repo <selector> --query <text> [--limit <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'repo', 'query', 'limit']
  },
  {
    path: ['repo', 'github-members'],
    summary: 'Show GitHub member policy and assignments for a repo',
    usage: 'orca repo github-members --repo <selector> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'repo'],
    notes: [
      'The local server owner sees members and paired device IDs; paired clients see only their own account choices.'
    ]
  },
  {
    path: ['repo', 'github-member-save'],
    summary: 'Create or replace a GitHub member assignment on this server',
    usage: 'orca repo github-member-save --repo <selector> --file <member.json> [--json]',
    allowedFlags: [...LOCAL_COMMAND_FLAGS, 'repo', 'file'],
    notes: [
      'Run on the server shell as its owner; paired connections cannot administer members.',
      'JSON fields: id (optional, to update), name, deviceIds (array), allowedAccounts (array of {host, user}). Updates replace both arrays. No tokens or other keys are accepted.'
    ]
  },
  {
    path: ['repo', 'github-member-remove'],
    summary: 'Remove a GitHub member assignment on this server',
    usage: 'orca repo github-member-remove --repo <selector> --id <member-id> [--json]',
    allowedFlags: [...LOCAL_COMMAND_FLAGS, 'repo', 'id'],
    notes: [
      'Run on the server shell as its owner. Find member IDs with repo github-members --json.'
    ]
  },
  {
    path: ['repo', 'github-members-mode'],
    summary: 'Enable or disable shared repo GitHub member policy on this server',
    usage: 'orca repo github-members-mode --repo <selector> --mode enabled|disabled [--json]',
    allowedFlags: [...LOCAL_COMMAND_FLAGS, 'repo', 'mode'],
    notes: [
      'Run on the server shell as its owner. This changes shared repo policy for all paired clients.',
      'Enabling requires paired clients to use an assigned member account; disabling restores the repo-wide account binding.'
    ]
  }
]
