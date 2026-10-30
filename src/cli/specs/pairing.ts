import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const PAIRING_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['pairing', 'create'],
    summary: 'Mint a pairing / access-grant URL against the running Orca runtime',
    usage:
      'orca pairing create [--address <host-or-url>] [--name <label>] [--scope runtime|mobile] [--rotate] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'address', 'name', 'scope', 'rotate'],
    notes: [
      'Calls pairing.createOffer on the running local runtime (or --environment / --pairing-code remote runtime).',
      'Default scope is runtime (full access grant). Use --scope mobile for phone QR-style grants.',
      'Minted grants appear in Settings → Runtime Environments and remain revocable there.',
      'This method is intentionally unavailable to mobile-scoped device tokens.'
    ],
    examples: [
      'orca pairing create --address 100.64.1.20 --json',
      'orca pairing create --name "SSH peer" --rotate',
      'orca pairing create --environment work-laptop --address 100.64.1.20'
    ]
  }
]
