import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const REFERENCE_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['reference', 'list'],
    summary: 'List the reviews and issues attached to a workspace',
    usage: 'orca reference list --worktree <selector> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree']
  },
  {
    path: ['reference', 'add'],
    summary: 'Attach reviews or issues to a workspace',
    usage: 'orca reference add <url>... --worktree <selector> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree', 'url'],
    positionalArgs: ['url'],
    variadicPositional: true,
    repeatableFlags: ['url'],
    notes: ['Full URLs only. Existing links are unchanged; all URLs are validated before writing.'],
    examples: [
      'orca reference add https://github.com/acme/api/pull/5123 https://linear.app/acme/issue/STA-1234 --worktree name:api'
    ]
  },
  {
    path: ['reference', 'remove'],
    aliases: [['reference', 'rm']],
    summary: 'Detach reviews or issues from a workspace',
    usage: 'orca reference remove [<url>...] [--key <key>...] --worktree <selector> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree', 'url', 'key'],
    positionalArgs: ['url'],
    variadicPositional: true,
    repeatableFlags: ['url', 'key'],
    notes: [
      'Use full URLs, or opaque --key values from reference list for older links without URLs.',
      'Removing an absent link succeeds without changing the workspace.'
    ]
  },
  {
    path: ['reference', 'find'],
    summary: 'Find workspaces and agents associated with a review or issue',
    usage:
      'orca reference find <url-or-issue-key> [--worktree <selector>|--repo <selector>] [--include-archived] [--limit <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'query', 'worktree', 'repo', 'include-archived', 'limit'],
    positionalArgs: ['query'],
    notes: [
      'Reads stored references only. Use orca search to search agent conversations.',
      'Issue keys search every matching source. Bare numbers and custom shorthand are unsupported.',
      'Returns up to 50 workspaces by default; truncated is true when more match.',
      'linked means recorded evidence associates that agent with the reference; workspace membership alone does not establish ownership.'
    ],
    examples: ['orca reference find STA-1234 --json']
  }
]
