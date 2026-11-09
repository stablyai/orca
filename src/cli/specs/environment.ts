import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS, LOCAL_COMMAND_FLAGS } from '../args'

export const ENVIRONMENT_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['server', 'name'],
    legacyAliases: [['host', 'name']],
    summary:
      'Show or set the name this Orca server reports (its computer name, not its saved name)',
    usage: 'orca server name [--name <name>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'name'],
    notes: [
      'With --name, updates the answering server over its authenticated connection. Use an empty value to return to the detected computer name.',
      'Without --name, prints the name and platform the answering server reports.'
    ],
    examples: ['orca server name', 'orca server name --name build-server']
  },
  {
    path: ['host', 'list'],
    hidden: true,
    summary: 'List this computer, its SSH connections and saved Orca servers',
    usage: 'orca host list [--json]',
    allowedFlags: [...LOCAL_COMMAND_FLAGS],
    notes: [
      'Lists this computer, the SSH connections registered on it, and the saved Orca servers. To run a command on a server, use --server; see `orca server list`.',
      'SSH rows include the detected remote platform after that target has connected (linux, darwin, or win32); disconnected or older targets report platform unknown.',
      'SSH rows also include whether the target is currently connected and its lifecycle status when known.',
      'Saved-server rows come from the pairing store and report platform unknown; ask one server directly with `orca server name --server <id>`.',
      "SSH connections are read from the Orca on this computer, so this lists this computer's connections and not another server's.",
      '--server and --pairing-code are rejected rather than ignored: saved servers come from this computer\u2019s pairing store, so a routed answer would describe two computers at once.'
    ],
    examples: ['orca host list', 'orca host list --json']
  },
  {
    path: ['host', 'rm'],
    hidden: true,
    destructive: true,
    summary: 'Remove one saved SSH connection from the Orca on this computer',
    usage: 'orca host rm --host ssh:<target-id> [--json]',
    allowedFlags: [...LOCAL_COMMAND_FLAGS, 'host'],
    notes: [
      'Removes the target the same way Settings does: its connection closes, and the passive ~/.ssh/config import does not add the alias back. Restore removed hosts in Settings brings it back.',
      'Takes only the --host ssh:<target-id> form that `orca host list` prints. This computer and saved Orca servers are refused; remove a saved server with `orca server rm`.',
      '--server and --pairing-code are rejected rather than ignored: SSH connections are removed from the Orca on this computer.'
    ],
    examples: [
      'orca host rm --host ssh:ssh-1783599077486-fyasux',
      'orca host rm --host ssh:ssh-1783599077486-fyasux --json'
    ]
  },
  {
    path: ['server', 'add'],
    legacyAliases: [['environment', 'add']],
    summary: 'Save an Orca server from a pairing code',
    usage: 'orca server add --name <name> --pairing-code <code> [--json]',
    allowedFlags: [...LOCAL_COMMAND_FLAGS, 'pairing-code', 'name'],
    examples: ['orca server add --name work-laptop --pairing-code orca://pair?code=...']
  },
  {
    path: ['server', 'list'],
    legacyAliases: [['environment', 'list']],
    summary: 'List saved Orca servers',
    usage: 'orca server list [--json]',
    allowedFlags: [...LOCAL_COMMAND_FLAGS],
    notes: [
      'Answers from this computer\u2019s pairing store and never contacts a server. `local` (the Orca on this computer) is always available and is not listed.',
      '--server and --pairing-code are rejected rather than ignored, because no other server could answer.'
    ]
  },
  {
    path: ['server', 'show'],
    legacyAliases: [['environment', 'show']],
    summary: 'Show one saved server',
    usage: 'orca server show --server <id|name> [--json]',
    allowedFlags: [...LOCAL_COMMAND_FLAGS, 'server']
  },
  {
    path: ['server', 'rm'],
    legacyAliases: [['environment', 'rm']],
    destructive: true,
    summary: 'Remove a saved server',
    usage: 'orca server rm --server <id|name> [--json]',
    allowedFlags: [...LOCAL_COMMAND_FLAGS, 'server']
  }
]
