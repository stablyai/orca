import type { CommandSpec } from '../discovery/command-spec'
import { CLI_GLOBAL_FLAGS as GLOBAL_FLAGS } from '../../shared/cli-argument-boundary'

const SETTINGS_SYNC_NOTES = [
  'Copies preferences that mean the same on any computer: theme, language, fonts, terminal and editor appearance, diff views, source control views and branch naming.',
  'Paths, accounts, secrets, the machine name, plugin approvals, agent launch flags, keybindings and platform-specific options stay on each computer.',
  'Custom and plugin terminal themes and plugin languages stay too: their palettes and language packs live on each computer.',
  'The receiving Orca checks every value and applies changes the way its Settings window does. It lists settings it does not copy, for example ones an older Orca does not know.',
  '--dry-run lists the settings that would change without writing.'
]

export const SETTINGS_SYNC_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['settings', 'push'],
    destructive: true,
    summary: 'Copy this computer’s portable settings to a paired Orca',
    usage: 'orca settings push --environment <name> [--dry-run] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'dry-run'],
    notes: SETTINGS_SYNC_NOTES,
    examples: [
      'orca settings push --environment work-mac --dry-run',
      'orca settings push --environment work-mac'
    ]
  },
  {
    path: ['settings', 'pull'],
    destructive: true,
    summary: 'Copy a paired Orca’s portable settings to this computer',
    usage: 'orca settings pull --environment <name> [--dry-run] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'dry-run'],
    notes: SETTINGS_SYNC_NOTES,
    examples: [
      'orca settings pull --environment work-mac --dry-run',
      'orca settings pull --environment work-mac'
    ]
  }
]
