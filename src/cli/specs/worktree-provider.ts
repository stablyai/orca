import type { CommandSpec } from '../discovery/command-spec'
import { CLI_GLOBAL_FLAGS as GLOBAL_FLAGS } from '../../shared/cli/cli-argument-boundary'

export const WORKTREE_PROVIDER_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['worktree', 'acquire'],
    summary: 'Claim a worktree from a configured provider',
    usage:
      'orca worktree acquire --provider <name> [--repo <selector>] [--profile <name>] [--agent <id>] [--prompt <text>] [--model <id>] [--effort <level>] [--surface chat|terminal] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'provider',
      'repo',
      'profile',
      'agent',
      'prompt',
      'model',
      'effort',
      'surface'
    ],
    notes: [
      'The provider runs on the Orca host that owns the repository. Its claim command must print one JSON object with an absolute "path" (plus optional "lease_id", "profile", and "handle").',
      'The returned path must be a linked Git worktree of the repository. Orca registers it as provider-managed and never runs `git worktree remove` on it.',
      'The provider config comes from ~/.orca/worktree-providers.yaml or, when trusted, the repository orca.yaml. Run `orca worktree providers list` to see what is configured.',
      'Provider setup runs after claim; repo orca.yaml setup hooks do not run for provider-acquired workspaces.',
      'Pass --agent to start an agent in the acquired workspace. The agent launch uses the same flags as `orca agent launch`.',
      'Release the workspace with `orca worktree release <selector>`; `worktree rm` refuses provider-managed workspaces.'
    ],
    examples: [
      'orca worktree acquire --provider wtp --repo path:/path/to/repo --profile cone --agent claude --json',
      'orca worktree acquire --provider wtp --agent claude --prompt "Fix the failing test" --json'
    ]
  },
  {
    path: ['worktree', 'release'],
    summary: 'Release a provider-managed worktree back to its pool',
    usage: 'orca worktree release <selector> [--force] [--forget] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree', 'force', 'forget'],
    positionalArgs: ['worktree'],
    destructive: true,
    notes: [
      'Runs the provider release command with the workspace path, lease id, and handle. On exit 0 Orca stops the workspace terminals and unregisters it; on nonzero it keeps the workspace and prints the provider message.',
      'Use --force to ask the provider to discard uncommitted changes. A dirty-worktree refusal is a normal nonzero outcome.',
      'Use --forget to unregister without running the provider, for example when its config is gone. The lease may still be held.',
      'Pass a full `id:<repoId>::<path>` selector to release a workspace whose checkout is already gone. `path:` also works while the checkout exists.',
      'Orca never runs `git worktree remove` on a provider-managed workspace.'
    ],
    examples: [
      'orca worktree release id:<repoId>::/path/to/slot --json',
      'orca worktree release path:/path/to/slot --force',
      'orca worktree release name:wtp-slot-3 --forget --json'
    ]
  },
  {
    path: ['worktree', 'providers', 'list'],
    summary: 'List configured worktree providers',
    usage: 'orca worktree providers list --repo <selector> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'repo'],
    notes: [
      'Reads ~/.orca/worktree-providers.yaml and the repository orca.yaml. It never runs a provider command.',
      'Repo-level providers are untrusted until `orca worktree providers trust` records a hash of their commands.'
    ],
    examples: ['orca worktree providers list --repo path:/path/to/repo --json']
  },
  {
    path: ['worktree', 'providers', 'trust'],
    summary: "Trust the repository's current worktree provider commands",
    usage: 'orca worktree providers trust --repo <selector> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'repo'],
    notes: [
      'Prints the claim, release, and optional setup commands from the repository orca.yaml, then records a content hash in ~/.orca/worktree-providers-trust.json.',
      'Any later change to the provider block invalidates the approval; run this command again after reviewing the new commands.',
      'Only repo-level providers need trust. Providers in ~/.orca/worktree-providers.yaml are user-authored and run without approval.'
    ],
    examples: ['orca worktree providers trust --repo id:<repoId>']
  }
]
