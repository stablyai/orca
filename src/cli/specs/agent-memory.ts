import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

const TARGET_FLAGS = ['worktree']

export const AGENT_MEMORY_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['agent', 'memory', 'init'],
    summary: 'Initialize durable, project-scoped agent memory for a workspace',
    usage: 'orca agent memory init [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, ...TARGET_FLAGS],
    notes: [
      'Creates .orca/memory with immutable Markdown entries and does not contact an AI provider.',
      'When --worktree is omitted, the enclosing Orca workspace is inferred from cwd.'
    ],
    examples: ['orca agent memory init', 'orca agent memory init --worktree active --json']
  },
  {
    path: ['agent', 'memory', 'remember'],
    summary:
      'Record a cited decision, constraint, fact, lesson, task outcome, or architecture note',
    usage:
      'orca agent memory remember --title <text> (--body <text> | --body-file <path>) --source <ref> [options]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      ...TARGET_FLAGS,
      'title',
      'body',
      'body-file',
      'source',
      'tag',
      'kind',
      'confidence',
      'supersedes'
    ],
    notes: [
      'Records are immutable. Use --supersedes <memory-id> when newer knowledge replaces an older record.',
      '--body-file is relative to the selected workspace, including for SSH and folder workspaces.',
      'Repeat --source and --tag to attach multiple citations or retrieval labels.',
      'Kinds: architecture, constraint, decision, fact, lesson, task. Confidence: low, medium, high.'
    ],
    examples: [
      'orca agent memory remember --title "Auth boundary" --body "Tokens stay in the host keychain." --kind decision --confidence high --source docs/security.md --tag auth',
      'orca agent memory remember --title "Build outcome" --body-file notes/build.md --kind task --source issue:#123 --json'
    ]
  },
  {
    path: ['agent', 'memory', 'search'],
    summary: 'Search active project memories with deterministic lexical retrieval',
    usage:
      'orca agent memory search <query> [--kind <kind>] [--tag <tag>] [--limit <n>] [--include-superseded] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      ...TARGET_FLAGS,
      'query',
      'kind',
      'tag',
      'limit',
      'include-superseded'
    ],
    positionalArgs: ['query'],
    notes: [
      'Search is local to the selected workspace and does not require embeddings or an API key.',
      'Superseded records are excluded unless --include-superseded is passed.'
    ],
    examples: [
      'orca agent memory search "authentication boundary"',
      'orca agent memory search build --kind lesson --limit 5 --json'
    ]
  },
  {
    path: ['agent', 'memory', 'show'],
    summary: 'Show one agent-memory record and its supersession status',
    usage: 'orca agent memory show <memory-id> [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, ...TARGET_FLAGS, 'id'],
    positionalArgs: ['id'],
    examples: ['orca agent memory show mem_20260726T120000Z_auth-boundary_a1b2c3d4']
  }
]
