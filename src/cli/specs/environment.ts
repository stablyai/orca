import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const ENVIRONMENT_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['environment', 'add'],
    summary: 'Save a remote Orca runtime environment from a pairing code',
    usage: 'orca environment add --name <name> --pairing-code <code> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'name'],
    examples: ['orca environment add --name work-laptop --pairing-code orca://pair?code=...']
  },
  {
    path: ['environment', 'devcontainer-up'],
    summary: 'Start Orca inside a devcontainer and save the paired environment',
    usage:
      'orca environment devcontainer-up --name <env-name> --container <container> --host-port <port> [--container-port <port>] [--orca-bin <path>] [--bridge-name <name>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'name',
      'container',
      'host-port',
      'container-port',
      'orca-bin',
      'bridge-name'
    ],
    notes: [
      'Starts a temporary Docker/socat bridge that forwards the host port to the devcontainer network.',
      'The helper runs `orca serve --json` inside the container and saves the environment from the readiness payload.',
      '--container-port defaults to 6768 when omitted.',
      '--bridge-name defaults to a sanitized `orca-devcontainer-<name>` value.'
    ],
    examples: [
      'orca environment devcontainer-up --name lac-devcontainer --container lac-devcontainer --host-port 31682 --container-port 6768 --orca-bin orca --json'
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
    summary: 'Remove one saved Orca runtime environment',
    usage: 'orca environment rm --environment <selector> [--json]',
    allowedFlags: [...GLOBAL_FLAGS]
  }
]
