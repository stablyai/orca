import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const AGENT_ROSTER_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['agent', 'roster'],
    summary: 'List the coding agents enabled in Orca on the selected runtime host',
    usage: 'orca agent roster [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    notes: [
      'Lists Orca configuration, not agent detection or installed binaries. Enabled ids are allowed launchers when installed; disabled ids remain configured but unavailable for launch.',
      'Uses the selected Orca runtime: pass --environment or --pairing-code to inspect a paired host. This command does not require a desktop window.',
      'With --json, prints exactly enabled, disabled, and default.'
    ],
    examples: ['orca agent roster', 'orca agent roster --json']
  }
]
