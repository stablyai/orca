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
      "SSH targets are read from this machine's own Orca runtime, so this lists that machine's targets and not another server's. Run `orca host list` on the other machine to see the targets registered there.",
      '--environment and --pairing-code are rejected rather than ignored: paired servers come from this machine\u2019s pairing store, so a routed answer would describe two machines at once.'
    ],
    examples: ['orca host list', 'orca host list --json']
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
    usage: 'orca environment list [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    notes: [
      'Answers from this machine\u2019s pairing store. --environment and --pairing-code are rejected rather than ignored, because there is no other host that could answer.'
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
    destructive: true,
    summary: 'Remove one saved Orca runtime environment',
    usage: 'orca environment rm --environment <selector> [--json]',
    allowedFlags: [...GLOBAL_FLAGS]
  }
]
