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
    path: ['repo', 'set-base-ref'],
    summary: "Set the repo's default base ref for future worktrees",
    usage: 'orca repo set-base-ref --repo <selector> --ref <ref> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'repo', 'ref']
  },
  {
    path: ['repo', 'hooks', 'show'],
    summary: 'Show the setup and archive scripts a repo runs for new worktrees',
    usage: 'orca repo hooks show --repo <selector> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'repo'],
    notes: [
      'Local scripts are stored on this machine; orca.yaml scripts are committed and shared with the team.',
      'The effective script is what the execution host would actually run, after the command-source policy is applied.'
    ],
    examples: ['orca repo hooks show --repo orca --json']
  },
  {
    path: ['repo', 'hooks', 'set'],
    summary: "Update a repo's local worktree hook scripts and setup policies",
    usage:
      'orca repo hooks set --repo <selector> [--setup-script <text|null>|--setup-script-file <path|->] [--archive-script <text|null>|--archive-script-file <path|->] [--setup-run-policy ask|run-by-default|skip-by-default] [--agent-startup start-immediately|wait-for-setup] [--command-source shared-only|local-only|run-both] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'repo',
      'setup-script',
      'setup-script-file',
      'archive-script',
      'archive-script-file',
      'setup-run-policy',
      'agent-startup',
      'command-source'
    ],
    notes: [
      'Writes the local settings for this machine, the same ones the Repository settings pane edits; it never edits the committed orca.yaml.',
      'Pass --setup-script null (or --archive-script null) to clear a local script.',
      'Use --setup-script-file - to read a multi-line script from stdin.',
      'Setting a local script while orca.yaml also has one changes which script runs; the printed effective script is the one that will run.',
      'Folder projects are rejected because worktree hooks only run for git projects.'
    ],
    examples: [
      'orca repo hooks set --repo orca --setup-script "pnpm install" --json',
      'orca repo hooks set --repo orca --setup-script-file - < setup.sh',
      'orca repo hooks set --repo orca --setup-run-policy skip-by-default --agent-startup wait-for-setup'
    ]
  },
  {
    path: ['repo', 'search-refs'],
    summary: 'Search branch/tag refs within a repo',
    usage: 'orca repo search-refs --repo <selector> --query <text> [--limit <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'repo', 'query', 'limit']
  }
]
