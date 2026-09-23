import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const PROFILE_STATE_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['profile', 'state', 'exports'],
    summary: 'List retained SQLite backups and JSON exports for profile-state recovery',
    usage: 'orca profile state exports [--json]',
    allowedFlags: [...GLOBAL_FLAGS]
  },
  {
    path: ['profile', 'state', 'rollback'],
    destructive: true,
    summary: 'Restore a retained SQLite backup or JSON export after profile-state corruption',
    usage: 'orca profile state rollback (--backup <id> | --revision <revision>) [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'revision', 'backup'],
    notes: [
      'Orca must be stopped. Recovery validates the selected artifact and archives the current database family, JSON, and retained recovery artifacts before replacing state.',
      '--backup restores SQLite authority; --revision restores a JSON export for an older compatible runtime.'
    ],
    examples: [
      'orca profile state exports',
      'orca profile state rollback --backup <id>',
      'orca profile state rollback --revision 1'
    ]
  }
]
