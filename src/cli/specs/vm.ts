import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS, LOCAL_COMMAND_FLAGS } from '../args'

export const VM_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['provider', 'list'],
    summary: 'List the providers `orca worktree create --on` can use to create a new host',
    usage: 'orca provider list [--repo <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'repo'],
    notes: [
      "Lists each repo's orca.yaml environment recipes (recipe:<id>) and approved plugin recipes (plugin:<plugin>/<id>), as the Orca desktop app on this computer sees them. Pass --repo to list one repo.",
      'Each provider shows its checkout mode, whether removing its workspace destroys the new host, any per-step timeouts, and why it is unavailable if it is.',
      'With --json the result has schemaVersion 1 and a fixed set of fields: target, kind, name, description, repo, available, unavailableReason, checkoutMode, capabilities, timeoutSeconds, sizes, inputs.'
    ],
    examples: ['orca provider list', 'orca provider list --repo id:<repoId> --json']
  },
  {
    path: ['provider', 'show'],
    summary: 'Show one provider: its capabilities, sizes, inputs and availability',
    usage: 'orca provider show <target> [--repo <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'target', 'repo'],
    positionalArgs: ['target'],
    notes: [
      'An unknown target fails with invalid_argument (exit 2) and lists the valid targets in data.valid.'
    ],
    examples: ['orca provider show recipe:dev-vm --repo id:<repoId> --json']
  },
  {
    path: ['provider', 'doctor'],
    summary: 'Validate a recipe provider without creating anything by default',
    usage: 'orca provider doctor <recipe:id> [--repo-path <path>] [--provision|--connect] [--json]',
    allowedFlags: [...LOCAL_COMMAND_FLAGS, 'target', 'repo-path', 'provision', 'connect'],
    positionalArgs: ['target'],
    notes: ['The same check as `orca vm recipe doctor <id>`.'],
    examples: ['orca provider doctor recipe:dev-vm --repo-path /path/to/repo']
  },
  {
    path: ['vm', 'recipe', 'doctor'],
    summary: 'Validate a per-workspace environment recipe without provisioning by default',
    usage:
      'orca vm recipe doctor <recipe-id> [--repo-path <path>] [--provision|--connect] [--json]',
    allowedFlags: [...LOCAL_COMMAND_FLAGS, 'recipe-id', 'repo-path', 'provision', 'connect'],
    positionalArgs: ['recipe-id'],
    notes: [
      'Reads environmentRecipes from orca.yaml in the repo path, validates the selected recipe, and reports agent-friendly checks.',
      'This default mode is non-destructive and does not run the recipe command.',
      'Use --provision or --connect to run the recipe, validate its result, and run cleanup when configured.'
    ],
    examples: [
      'orca vm recipe doctor cloud-sandbox',
      'orca vm recipe doctor cloud-sandbox --repo-path /path/to/repo --json',
      'orca vm recipe doctor cloud-sandbox --provision --json'
    ]
  }
]
