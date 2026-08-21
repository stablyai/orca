import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const ENVIRONMENT_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['host', 'list'],
    summary: 'List every machine this MCode host can target, and how to name each one',
    usage: 'mcode host list [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    notes: [
      'Answers "what can I target and what do I pass" in one place: this machine, the SSH targets registered on it, and the MCode servers paired with it.',
      'The three kinds are reached differently. A paired MCode server is a connection, selected with --environment <name>. An SSH target is a machine the connected MCode host reaches, selected with --host ssh:<id>. Passing one where the other belongs is the most common way to get an empty or missing-host answer.',
      "SSH targets are read from the MCode host you are currently connected to, so this lists that host's targets and not another server's."
    ],
    examples: ['mcode host list', 'mcode host list --json']
  },
  {
    path: ['environment', 'add'],
    summary: 'Save a remote MCode runtime environment from a pairing code',
    usage: 'mcode environment add --name <name> --pairing-code <code> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'name'],
    examples: ['mcode environment add --name work-laptop --pairing-code mcode://pair?code=...']
  },
  {
    path: ['environment', 'list'],
    summary: 'List saved MCode runtime environments',
    usage: 'mcode environment list [--json]',
    allowedFlags: [...GLOBAL_FLAGS]
  },
  {
    path: ['environment', 'show'],
    summary: 'Show one saved MCode runtime environment',
    usage: 'mcode environment show --environment <selector> [--json]',
    allowedFlags: [...GLOBAL_FLAGS]
  },
  {
    path: ['environment', 'rm'],
    destructive: true,
    summary: 'Remove one saved MCode runtime environment',
    usage: 'mcode environment rm --environment <selector> [--json]',
    allowedFlags: [...GLOBAL_FLAGS]
  }
]
