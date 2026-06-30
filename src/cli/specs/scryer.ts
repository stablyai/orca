import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

const SCRYER_FLAGS = [...GLOBAL_FLAGS, 'project', 'lease-token']

export const SCRYER_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['scryer', 'model', 'read'],
    summary: 'Read a Scryer 0.3 model through the Native Scryer Engine',
    usage:
      'orca scryer model read [--project <path>] [--layer plan|committed] [--view overview|subtree|full] [--node <id>] [--full] [--json]',
    allowedFlags: [...SCRYER_FLAGS, 'layer', 'node', 'view', 'full'],
    examples: ['orca scryer model read --json', 'orca scryer model read --full --json']
  },
  {
    path: ['scryer', 'model', 'search'],
    summary: 'Search Scryer model nodes through the Native Scryer Engine',
    usage:
      'orca scryer model search --query <text> [--kind person|system|container|component|symbol] [--project <path>] [--layer plan|committed] [--json]',
    allowedFlags: [...SCRYER_FLAGS, 'query', 'kind', 'layer'],
    examples: ['orca scryer model search --query auth --json']
  },
  {
    path: ['scryer', 'model', 'query'],
    summary: 'Query Scryer model nodes by structural predicates',
    usage: 'orca scryer model query --json-input - [--project <path>] [--json]',
    allowedFlags: [...SCRYER_FLAGS, 'json-input'],
    notes: ['The JSON input must contain `where` or `conditions`.'],
    examples: [
      'echo \'{"where":[{"field":"kind","op":"eq","value":"component"}]}\' | orca scryer model query --json-input - --json'
    ]
  },
  {
    path: ['scryer', 'rules', 'read'],
    summary: 'Read Scryer modeling rules as structured payloads',
    usage: 'orca scryer rules read [--topic <text>] [--json]',
    allowedFlags: [...SCRYER_FLAGS, 'topic'],
    examples: ['orca scryer rules read --json', 'orca scryer rules read --topic links --json']
  },
  {
    path: ['scryer', 'codebase', 'read'],
    summary: 'Read a bounded annotated project tree for modeling context',
    usage:
      'orca scryer codebase read [--project <path>] [--path <path>] [--max-depth <n>] [--max-entries <n>] [--json]',
    allowedFlags: [...SCRYER_FLAGS, 'path', 'max-depth', 'max-entries'],
    examples: ['orca scryer codebase read --project . --json']
  },
  {
    path: ['scryer', 'model', 'validate'],
    summary: 'Validate a Scryer 0.3 model',
    usage: 'orca scryer model validate [--project <path>] [--layer plan|committed] [--json]',
    allowedFlags: [...SCRYER_FLAGS, 'layer'],
    examples: ['orca scryer model validate --project . --json']
  },
  {
    path: ['scryer', 'node', 'update'],
    summary: 'Patch planned Scryer nodes',
    usage: 'orca scryer node update --json-input - [--project <path>] [--json]',
    allowedFlags: [...SCRYER_FLAGS, 'json-input'],
    notes: ['The JSON input must contain the engine field `nodes`.'],
    examples: [
      'echo \'{"nodes":[{"node_id":"api","name":"API"}]}\' | orca scryer node update --json-input - --json'
    ]
  },
  {
    path: ['scryer', 'link', 'add'],
    summary: 'Add planned Scryer links',
    usage:
      'orca scryer link add (--json-input - | --src <id> --dst <id> --label <text>) [--project <path>] [--json]',
    allowedFlags: [...SCRYER_FLAGS, 'json-input', 'src', 'dst', 'label', 'method'],
    examples: ['orca scryer link add --src web --dst api --label calls --json']
  },
  {
    path: ['scryer', 'link', 'delete'],
    summary: 'Delete planned Scryer links',
    usage: 'orca scryer link delete --link-ids <id,id> [--project <path>] [--json]',
    allowedFlags: [...SCRYER_FLAGS, 'json-input', 'link-ids'],
    examples: ['orca scryer link delete --link-ids link-web-api --json']
  },
  {
    path: ['scryer', 'plan', 'pending'],
    summary: 'Read pending Scryer plan work',
    usage: 'orca scryer plan pending [--project <path>] [--json]',
    allowedFlags: SCRYER_FLAGS,
    examples: ['orca scryer plan pending --json']
  },
  {
    path: ['scryer', 'plan', 'fold'],
    summary: 'Fold planned Scryer work into committed state',
    usage:
      'orca scryer plan fold --node-id <id> [--responsibility-ids <id,id>] [--link-ids <id,id>] [--all] [--project <path>] [--json]',
    allowedFlags: [
      ...SCRYER_FLAGS,
      'json-input',
      'node-id',
      'responsibility-ids',
      'property-labels',
      'link-ids',
      'all'
    ],
    examples: ['orca scryer plan fold --node-id api --responsibility-ids resp-1 --json']
  }
]
