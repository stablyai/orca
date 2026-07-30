import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const INTROSPECTION_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['agent-context'],
    summary: 'Discover Orca commands with bounded machine-readable queries',
    usage:
      'orca agent-context [--roots|--command <path>|--prefix <path>|--search <terms>] [--limit <n>] [--full] [--compact] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'roots',
      'command',
      'prefix',
      'search',
      'limit',
      'full',
      'compact'
    ],
    notes: [
      'Pure local read of the command registry — works without a running Orca app, so it is safe over SSH and in headless contexts.',
      'Use --roots, --prefix, or --search for bounded discovery, then --command for one complete command definition.',
      'Selector responses use schema v2; destructive is warning metadata, not permission to run a command.',
      'Without a selector, --json preserves the full schema v1 response for compatibility.',
      '--limit applies only to --search; --full expands --prefix/--search results; --compact requires --json.'
    ],
    examples: [
      'orca agent-context --roots --json',
      'orca agent-context --search "setup hooks" --json',
      'orca agent-context --prefix orchestration --json',
      'orca agent-context --command "worktree create" --json',
      'orca agent-context --json'
    ]
  }
]
