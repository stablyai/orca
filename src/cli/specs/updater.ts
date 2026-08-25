import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

/** Argument/help specs for the `orca version` and `orca update` commands. */
export const UPDATER_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['version'],
    summary: 'Show the bundled Orca app and CLI version',
    usage: 'orca version [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    notes: ['The CLI ships inside Orca, so its version is the running app version.'],
    examples: ['orca version', 'orca version --json']
  },
  {
    path: ['update'],
    summary: 'Check for or install an Orca desktop app update',
    usage: 'orca update [--check] [--prerelease] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'check', 'prerelease'],
    notes: [
      'Without --check, downloads an available update and asks the running Orca app to install it.',
      'With --check, reports availability without downloading or installing.',
      'The running Orca app performs all update checks, downloads, and installation.'
    ],
    examples: ['orca update --check', 'orca update', 'orca update --check --prerelease --json']
  }
]
