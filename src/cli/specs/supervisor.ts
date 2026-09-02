import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

/**
 * Why `supervisor` and not `daemon` or `service`: `daemon` means the terminal daemon
 * throughout this codebase, and `service` is two characters from `serve` while one starts a
 * server and the other writes system files — the kind of neighbouring pair typo recovery
 * must never steer between. `supervisor` is the word orcad-operations.md already uses.
 *
 * These commands are registered local-only (`shouldIgnoreRemoteSelection`): they inspect
 * THIS machine's service files, which is normally not the host a paired CLI targets.
 */
export const SUPERVISOR_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['supervisor', 'print'],
    summary: 'Print a supervisor service definition for running orcad on this machine',
    usage:
      'orca supervisor print --orcad <path> [--scope user|system] [--user <account>] [--node <path>] [--port <port>] [--bind <address>]',
    allowedFlags: [...GLOBAL_FLAGS, 'orcad', 'scope', 'user', 'node', 'port', 'bind'],
    notes: [
      'Writes the file to stdout and changes nothing; placement and enable commands go to stderr.',
      '--orcad is required here: this process is the orca CLI, so it cannot name which orcad.js the service should run.',
      'Inspects and describes THIS machine, not a paired remote runtime.',
      'The generated file pins the data root, because a service inherits too little environment to resolve the same one your shell does.',
      'Defaults to a loopback bind; reach a remote orcad over an SSH port-forward rather than widening it.'
    ],
    examples: [
      'orca supervisor print --orcad ~/.orca-remote/orcad-0.1.0/orcad.js --scope system --user orca',
      'orca supervisor print --orcad /opt/orcad/orcad.js --scope user > ~/.config/systemd/user/orcad.service'
    ]
  },
  {
    path: ['supervisor', 'doctor'],
    summary: 'Check an installed orcad service for settings that would lose running terminals',
    usage: 'orca supervisor doctor [--service-path <path>] [--no-probe]',
    allowedFlags: [...GLOBAL_FLAGS, 'service-path', 'no-probe'],
    notes: [
      'Inspects and describes THIS machine, not a paired remote runtime.',
      'Exits non-zero only for settings that would destroy running terminals; observed state is reported, not failed.',
      'Anything it cannot establish is reported as unverified with the reason, never as a negative.',
      'Use --no-probe for the file-only audit, without shelling out to systemctl or launchctl.'
    ],
    examples: ['orca supervisor doctor', 'orca supervisor doctor --no-probe']
  }
]
