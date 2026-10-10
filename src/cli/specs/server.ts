import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const SERVER_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['server', 'link'],
    summary: 'Print a pairing URL that links a client to this Orca server',
    usage:
      'orca server link [--rotate] [--ttl <duration>] [--address <ip>] [--reach <network|this-computer>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'rotate', 'ttl', 'address', 'reach'],
    notes: [
      'Runs on the server machine itself, so --environment and --pairing-code are rejected rather than ignored.',
      '--ttl accepts durations like 30m, 24h, 7d, or a plain millisecond integer; the cap is 30d.',
      'When pairing is unavailable the failure names the reason (for example disabled_by_operator) without printing any URL.'
    ],
    examples: [
      'orca server link',
      'orca server link --ttl 24h --reach network',
      'orca server link --json'
    ]
  },
  {
    path: ['server', 'add'],
    summary: 'Save a paired Orca server from a pairing URL or code',
    usage:
      'orca server add <url-or-code> --name <name> [--pairing-code <code>] [--pairing-code-file <path>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'name', 'pairing-code', 'pairing-code-file'],
    positionalArgs: ['pairing-code'],
    notes: [
      'The pairing code comes from exactly one source: the positional argument, --pairing-code, or --pairing-code-file. Use `--pairing-code -` to read stdin.',
      'The code is never printed back in output or errors.'
    ],
    examples: [
      'orca server add orca://pair?code=... --name homelab',
      'orca server add --name homelab --pairing-code-file ./pairing.txt',
      'echo orca://pair?code=... | orca server add --name homelab --pairing-code -'
    ]
  }
]
