import type { CommandSpec } from '../discovery/command-spec'
import { LOCAL_COMMAND_FLAGS } from '../arguments/args'

export const SECRET_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['secret', 'request'],
    summary: 'Ask the person to provide a secret for this workspace',
    usage:
      'orca secret request <NAME> --reason "<why>" [--scope personal|repo] [--wait <sec>] [--json]',
    allowedFlags: [...LOCAL_COMMAND_FLAGS, 'name', 'reason', 'scope', 'wait'],
    positionalArgs: ['name'],
    optionalNumberFlags: ['wait'],
    notes: [
      'Orca shows the person a card with NAME and your reason; they type the value into Orca, not into this command or your conversation.',
      'Once saved, NAME is a plain environment variable: any command in this workspace can read it, you included. Do not print or log it.',
      'Once provided, NAME is set for new shells in this workspace. In the current shell run eval "$(orca-env)" (fish: orca-env --fish | source).',
      '--reason (at most 200 characters) is shown to the person as your words. Say what the secret unblocks.',
      '--scope is a hint: the person chooses where it is saved.',
      '--wait <sec> waits for an answer (default without a number: 900). Running the same request again while it is pending waits on it rather than asking twice.',
      "Agent keys (ANTHROPIC_*, OPENAI_* and similar) cannot be requested: they come from the person's sign-in or Orca Cloud secrets.",
      'Exits 1 when the request is declined, expires, or --wait ends without an answer.'
    ],
    examples: [
      'orca secret request STRIPE_TEST_KEY --reason "Run the checkout integration tests" --wait 600',
      'orca secret request SENTRY_DSN --reason "Upload source maps in the release script" --json'
    ]
  }
]
