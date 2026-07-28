import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const ENVIRONMENT_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['environment', 'add'],
    summary: 'Save a remote Orca runtime environment from a pairing code',
    usage: 'orca environment add --name <name> --pairing-code <code> [--endpoint <host>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'name', 'endpoint'],
    examples: [
      'orca environment add --name work-laptop --pairing-code orca://pair?code=...',
      'orca environment add --name work-laptop --pairing-code orca://pair?code=... --endpoint 100.64.0.2'
    ],
    notes: [
      'Use --endpoint when the host advertised an address this machine cannot reach (for example a 127.0.0.1 link generated for a LAN or Tailscale peer). It accepts a host, host:port, or ws(s):// URL and keeps the port from the pairing code when omitted.'
    ]
  },
  {
    path: ['environment', 'list'],
    summary: 'List saved Orca runtime environments',
    usage: 'orca environment list [--json]',
    allowedFlags: [...GLOBAL_FLAGS]
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
