import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

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
  }
]
