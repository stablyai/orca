import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS, LOCAL_COMMAND_FLAGS } from '../args'

export const VM_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['vm', 'recipe', 'list'],
    summary: 'List the environment recipes `orca worktree create --recipe` can use',
    usage: 'orca vm recipe list [--repo <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'repo'],
    notes: [
      "Lists recipes from each repo's orca.yaml plus approved plugin recipes, as the Orca desktop app on this computer sees them. Pass --repo to list one repo.",
      'Each recipe shows its checkout mode, whether removing its workspace destroys the environment, and any per-step timeouts from timeoutSeconds.',
      'orca.yaml problems that hid a recipe are listed as warnings; run `orca vm recipe doctor <recipe-id>` for details.'
    ],
    examples: ['orca vm recipe list', 'orca vm recipe list --repo id:<repoId> --json']
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
