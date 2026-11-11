import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const PAIR_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['pair'],
    summary:
      'Pair a phone or another Orca with the Orca already running here, without restarting it',
    usage:
      'orca pair [--mobile [--relay]] [--address <host>] [--grant-desktop-control] [--rotate] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'mobile',
      'relay',
      'address',
      'grant-desktop-control',
      'rotate'
    ],
    notes: [
      'Asks the Orca running for this profile (desktop app, `orca serve`, or its service) for a pairing offer. Nothing restarts and existing clients stay connected.',
      'Without --mobile it prints an access link for another Orca (Settings → Remote Orca Servers → Add Server). --mobile prints a QR code and link for Orca Mobile.',
      '--address is the host or IP the client should dial, such as a Tailscale address. Without it Orca picks this machine’s default LAN address.',
      'The first network pairing makes a loopback-only Orca listen on every interface, as pairing from the desktop app does.',
      'Mobile pairing is LAN-only (same network or tailnet) unless --relay is given; Relay needs a signed-in desktop app.',
      'An unused offer is reused until --rotate replaces it. Clients that already paired keep their access.',
      "--grant-desktop-control lets the paired Orca drive this machine's desktop (orca computer). It applies only to an access link, not to a phone.",
      'Only this machine’s own user can run it: paired clients and phones cannot create pairing offers.'
    ],
    examples: [
      'orca pair --mobile',
      'orca pair --mobile --address 100.64.1.20',
      'orca pair --address 100.64.1.20',
      'orca pair --mobile --rotate --json'
    ]
  }
]
