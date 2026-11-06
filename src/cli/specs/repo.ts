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
    usage: 'orca repo add --path <path> [--kind git|folder] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'path', 'kind'],
    notes: [
      'Defaults to git. Use --kind folder for an ordinary directory, including a parent of separate Git repositories; folder workspaces have no Git worktrees or source control.',
      'With --environment, --path must be an absolute path on that Orca server.'
    ],
    examples: ['orca repo add --path /abs/path/to/folder --kind folder --json']
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
    path: ['repo', 'delete-branch'],
    destructive: true,
    summary:
      'Delete an unattached local branch proven integrated at an exact remote default anchor',
    usage:
      'orca repo delete-branch --repo id:<repoId> --repo-host-id local --ref refs/heads/<branch> --expected-oid <fullOid> --anchor-ref refs/remotes/<remote>/<default> --anchor-oid <fullOid> [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'repo',
      'repo-host-id',
      'ref',
      'expected-oid',
      'anchor-ref',
      'anchor-oid'
    ],
    notes: [
      'Connect directly to the execution host (use --environment for a paired server); repo-host-id local means local to that server. SSH proxy targets and old hosts refuse this operation.',
      'Requires a configured source remote, verifiable symbolic HEADs for all remotes (maximum 32), complete ungrafted history, exact current OIDs, ancestry integration, and no worktree checkout or rebase/bisect reservation. Default and reserved branches are refused. No force, fetch, remote deletion or stash mutation.',
      'Caller owns fresh review, protected-main and activity checks. Squash-only integration is refused. Git compares both refs in one transaction; external Git attachments do not honor Orca locks. A detected attachment race attempts compare-and-create restoration and returns an error. After any error or lost reply, re-inventory before retrying.'
    ]
  },
  {
    path: ['repo', 'search-refs'],
    summary: 'Search branch/tag refs within a repo',
    usage: 'orca repo search-refs --repo <selector> --query <text> [--limit <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'repo', 'query', 'limit']
  }
]
