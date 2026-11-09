import type { CommandSpec } from '../args'
import { LOCAL_COMMAND_FLAGS } from '../args'

const SELECTOR_NOTE =
  '--server names a managed server this computer set up over SSH (see `orca server list`); here it picks the saved entry, it does not route the command.'
const DESKTOP_NOTE =
  'Runs on the Orca desktop app on this computer, the same action as Settings > Orca on your SSH hosts. A server without the SSH registry (headless `orca serve`) refuses it.'

export const MANAGED_SERVER_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['server', 'status'],
    legacyAliases: [['environment', 'status']],
    summary: 'Show a managed Orca server’s active version, terminals and pending work',
    usage: 'orca server status --server <id|name> [--json]',
    allowedFlags: [...LOCAL_COMMAND_FLAGS, 'server'],
    notes: [SELECTOR_NOTE, DESKTOP_NOTE],
    examples: ['orca server status --server build-box']
  },
  {
    path: ['server', 'update'],
    legacyAliases: [['environment', 'update']],
    summary: 'Update a managed Orca server to this build’s version',
    usage: 'orca server update --server <id|name> [--force] [--json]',
    allowedFlags: [...LOCAL_COMMAND_FLAGS, 'server', 'force'],
    notes: [
      'Without --force, an update that would restart over running terminals is deferred and reported, not applied.',
      SELECTOR_NOTE,
      DESKTOP_NOTE
    ],
    examples: ['orca server update --server build-box']
  },
  {
    path: ['server', 'rollback'],
    legacyAliases: [['environment', 'rollback']],
    destructive: true,
    summary: 'Roll a managed Orca server back to its previous version',
    usage: 'orca server rollback --server <id|name> [--json]',
    allowedFlags: [...LOCAL_COMMAND_FLAGS, 'server'],
    notes: [SELECTOR_NOTE, DESKTOP_NOTE]
  },
  {
    path: ['server', 'recover'],
    legacyAliases: [['environment', 'recover']],
    summary: 'Finish or undo a managed Orca server’s interrupted update, rollback or stop',
    usage: 'orca server recover --server <id|name> [--accept-changed-state --yes] [--json]',
    allowedFlags: [...LOCAL_COMMAND_FLAGS, 'server', 'accept-changed-state', 'yes'],
    notes: [
      'When a rejected build changed profile state, recover refuses rather than restart the previous build over it. --accept-changed-state --yes restores the prelaunch snapshot instead, the same as Restore in Settings > Orca on your SSH hosts; what the rejected build changed is discarded.',
      SELECTOR_NOTE,
      DESKTOP_NOTE
    ],
    examples: [
      'orca server recover --server build-box',
      'orca server recover --server build-box --accept-changed-state --yes'
    ]
  },
  {
    path: ['server', 'stop'],
    legacyAliases: [['environment', 'stop']],
    destructive: true,
    summary: 'Stop a managed Orca server and unlink it from this computer (decommission)',
    usage: 'orca server stop --server <id|name> --yes [--json]',
    allowedFlags: [...LOCAL_COMMAND_FLAGS, 'server', 'yes'],
    notes: [
      'Stops orcad on the SSH host and, once the host proves it exited, removes the server from this computer and disconnects the host. Its terminals end. Connecting the host again sets up a new server. Requires --yes.',
      'If the host cannot prove orcad exited, the server stays linked and the refusal says why; nothing is removed on a guess. For a host that is gone for good, use `orca server forget`.',
      'If this server is the default host for new projects, choose another one first. `orca server cancel-stop` withdraws a stop orcad has not acted on yet.',
      SELECTOR_NOTE,
      DESKTOP_NOTE
    ],
    examples: ['orca server stop --server build-box --yes']
  },
  {
    path: ['server', 'forget'],
    legacyAliases: [['environment', 'forget']],
    destructive: true,
    summary: 'Unlink a managed Orca server whose SSH host is gone, without stopping it',
    usage: 'orca server forget --server <id|name> --yes [--json]',
    allowedFlags: [...LOCAL_COMMAND_FLAGS, 'server', 'yes'],
    notes: [
      'Removes the server from this computer without contacting its host, so the SSH host can then be removed. Use it when the host was deleted or can never be reached again. Requires --yes.',
      'Nothing on the host is stopped: if it comes back, orcad may still be running there.',
      'The SSH host is left disconnected, since no Orca server serves it any more. Connecting it again (Connect in Orca) sets its server up again, relinking one still running there.',
      SELECTOR_NOTE,
      DESKTOP_NOTE
    ],
    examples: ['orca server forget --server build-box --yes']
  },
  {
    path: ['server', 'cancel-stop'],
    legacyAliases: [['environment', 'cancel-stop']],
    summary: 'Withdraw a managed Orca server stop that orcad has not acted on yet',
    usage: 'orca server cancel-stop --server <id|name> [--json]',
    allowedFlags: [...LOCAL_COMMAND_FLAGS, 'server'],
    notes: [SELECTOR_NOTE, DESKTOP_NOTE]
  }
]
