import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

const SCRYER_FLAGS = [...GLOBAL_FLAGS, 'project', 'lease-token']

export const SCRYER_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['scryer', 'model', 'read'],
    summary: 'Read a Scryer 0.3 model through the Native Scryer Engine',
    usage:
      'orca scryer model read [--project <path>] [--layer plan|committed] [--node <id>] [--json]',
    allowedFlags: [...SCRYER_FLAGS, 'layer', 'node'],
    examples: ['orca scryer model read --json']
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
