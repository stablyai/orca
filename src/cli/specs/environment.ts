import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const ENVIRONMENT_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['host', 'list'],
    summary: 'List every machine this Orca host can target, and how to name each one',
    usage: 'orca host list [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    notes: [
      'Answers "what can I target and what do I pass" in one place: this machine, the SSH targets registered on it, and the Orca servers paired with it.',
      'The three kinds are reached differently. A paired Orca server is a connection, selected with --environment <name>. An SSH target is a machine the connected Orca host reaches, selected with --host ssh:<id>. Passing one where the other belongs is the most common way to get an empty or missing-host answer.',
      'SSH rows include the detected remote platform after that target has connected (linux, darwin, or win32); disconnected or older targets report platform unknown.',
      'SSH rows also include whether the target is currently connected and its lifecycle status when known.',
      "SSH targets are read from this machine's own Orca runtime, so this lists that machine's targets and not another server's. Run `orca host list` on the other machine to see the targets registered there.",
      '--environment and --pairing-code are rejected rather than ignored: paired servers come from this machine\u2019s pairing store, so a routed answer would describe two machines at once.'
    ],
    examples: ['orca host list', 'orca host list --json']
  },
  {
    path: ['environment', 'create'],
    summary: 'Create and pair a recipe-backed Orca runtime environment',
    usage: 'orca environment create --recipe <id> [--name <name>] [--repo-path <path>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'recipe', 'name', 'repo-path'],
    notes: [
      'Runs the selected environmentRecipes entry from orca.yaml, saves its durable provider lifecycle record, and pairs the returned Orca server.',
      'The repository must already be registered in the local Orca runtime. The current directory is used unless --repo-path is provided.',
      'SSH recipes and provisioned-root recipes are not supported by this first CLI lifecycle surface; use the Orca desktop flow for those.'
    ],
    examples: [
      'orca environment create --recipe haven-aws-remote',
      'orca environment create --recipe haven-aws-remote --name haven-aws-live --json'
    ]
  },
  {
    path: ['environment', 'add'],
    summary: 'Save a remote Orca runtime environment from a pairing code',
    usage: 'orca environment add --name <name> --pairing-code <code> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'name'],
    examples: ['orca environment add --name work-laptop --pairing-code orca://pair?code=...']
  },
  {
    path: ['environment', 'list'],
    summary: 'List saved Orca runtime environments',
    usage: 'orca environment list [--include-provider-state] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'include-provider-state'],
    notes: [
      'Answers from this machine\u2019s pairing store. --environment and --pairing-code are rejected rather than ignored, because there is no other host that could answer.',
      "--include-provider-state adds Orca's durable last-known recipe lifecycle state and redacted provider result. It does not query the cloud provider live."
    ]
  },
  {
    path: ['environment', 'show'],
    summary: 'Show one saved Orca runtime environment',
    usage: 'orca environment show --environment <selector> [--json]',
    allowedFlags: [...GLOBAL_FLAGS]
  },
  {
    path: ['environment', 'rm'],
    aliases: [['environment', 'destroy']],
    destructive: true,
    summary: 'Destroy a recipe-backed environment or forget a manual pairing',
    usage: 'orca environment rm --environment <selector> [--force] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'force'],
    notes: [
      '`environment destroy` is an alias for this command.',
      'For a recipe-backed environment, runs the immutable destroy recipe stored at creation and removes the pairing only after cleanup succeeds.',
      'For a manual pairing with no recipe lifecycle record, removes only the local pairing and explicitly reports that no provider cleanup ran.',
      '--force forgets a recipe-backed pairing only after you independently confirmed its provider resource is gone. It does not run provider cleanup.'
    ],
    examples: [
      'orca environment destroy --environment haven-aws-live --json',
      'orca environment rm --environment work-laptop --json'
    ]
  }
]
