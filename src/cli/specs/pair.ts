import type { CommandSpec } from '../discovery/command-spec'
import { CLI_GLOBAL_FLAGS as GLOBAL_FLAGS } from '../../shared/cli/cli-argument-boundary'

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
      'The first network pairing makes a loopback-only Orca listen on every interface, as pairing from the desktop app does. An Orca started on a fixed address (`orca serve --bind`, or an SSH-managed server) keeps it; on loopback, phones pair only through --relay or an --address that forwards to it.',
      'Mobile pairing is LAN-only (same network or tailnet) unless --relay is given; Relay needs this host’s Orca signed in (`orca auth login`).',
      'An unused offer is reused until --rotate replaces it. After Orca restarts it can’t be printed again, so a new one is made and the earlier link keeps working until --rotate. Clients that already paired keep their access.',
      "--grant-desktop-control lets Orca drive this machine's desktop (orca computer) for the paired Orca. Off, Orca won't do it for the client; anything with a terminal here can. It applies only to an access link, not to a phone.",
      'Paired clients and phones can’t create offers through Orca, but anything with a terminal here can. Revoking a paired client also revokes links made from terminals it opened.'
    ],
    examples: [
      'orca pair --mobile',
      'orca pair --mobile --address 100.64.1.20',
      'orca pair --address 100.64.1.20',
      'orca pair --mobile --rotate --json'
    ]
  }
]
