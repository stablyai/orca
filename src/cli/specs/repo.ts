import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

// Why: the repo command family is large enough (add/remove/show/ref helpers)
// to live in its own spec module, matching the serve/project split and keeping
// core.ts under its max-lines budget.

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
    path: ['repo', 'rm'],
    // Why: agents reach for git's `remove`/`delete` verbs, and `unregister`
    // matches the issue #9028 discoverability ask — accept all three as aliases
    // so a conventional guess resolves instead of dead-ending at `repo rm`.
    aliases: [
      ['repo', 'remove'],
      ['repo', 'delete'],
      ['repo', 'unregister']
    ],
    destructive: true,
    summary: 'Unregister a repo from Orca (preserves the checkout on disk)',
    usage: 'orca repo rm --repo <selector> [--force] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'repo', 'force'],
    notes: [
      'Removes Orca registration metadata only; the filesystem checkout is never deleted.',
      'Fails with an actionable error if live terminals are attached, unless --force is passed.',
      'Idempotent: unregistering an already-absent repo reports no changes instead of erroring.',
      'For removing an independent project host setup, use `orca project setup-delete --setup <id>`.'
    ],
    examples: [
      'orca repo rm --repo id:<repoId> --json',
      'orca repo rm --repo path:/abs/repo --json',
      'orca repo rm --repo id:<repoId> --force --json'
    ]
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
