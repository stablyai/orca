import type { CommandSpec } from '../args'
import { LOCAL_COMMAND_FLAGS } from '../args'

export const INTROSPECTION_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['agent-context'],
    summary: 'Print the machine-readable command schema for agents',
    usage: 'orca agent-context [--json]',
    allowedFlags: [...LOCAL_COMMAND_FLAGS],
    notes: [
      'Pure local read of the command registry — works without a running Orca app, so it is safe over SSH and in headless contexts.'
    ],
    examples: ['orca agent-context --json']
  }
]
