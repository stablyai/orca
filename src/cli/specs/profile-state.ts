import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const PROFILE_STATE_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['profile', 'state', 'exports'],
    summary: 'List retained SQLite backups and JSON exports for profile-state recovery',
    usage: 'orca profile state exports [--profile-id <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'profile-id']
  },
  {
    path: ['profile', 'state', 'rollback'],
    destructive: true,
    summary:
      'Restore a SQLite backup or retained JSON export, or keep the current JSON or SQLite profile',
    usage:
      'orca profile state rollback (--backup <id> | --revision <revision> | --current-json | --current-sqlite | --latest-json) [--dry-run] [--profile-id <id>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'revision',
      'backup',
      'current-json',
      'current-sqlite',
      'latest-json',
      'dry-run',
      'profile-id'
    ],
    notes: [
      '--dry-run (with --backup or --revision only) previews which domains would be lost, changed, or added without writing anything. A live Orca needs no stop for the preview itself; stop Orca before applying a rollback without --dry-run.',
      '--profile-id selects another profile without changing the active profile. Prepare each profile before installing a JSON-only build.',
      'Orca must be stopped before applying a rollback (unless previewing with --dry-run). Recovery validates the selected artifact and archives the current database family, JSON, and retained recovery artifacts before replacing state.',
      '--backup restores SQLite authority; --revision restores a JSON export for an older compatible runtime.',
      '--latest-json exports the latest SQLite state and restores it as JSON before launching an older JSON-only build. The current database and recovery artifacts are archived.',
      '--current-json keeps the current orca-data.json, including edits from an older build. It replaces SQLite state without merging; both copies are archived. The next SQLite-capable start imports the selected JSON.',
      '--current-sqlite keeps the current SQLite state and discards JSON edits from an older build. The JSON is archived, then rewritten from SQLite.'
    ],
    examples: [
      'orca profile state exports',
      'orca profile state rollback --backup <id> --dry-run',
      'orca profile state rollback --backup <id>',
      'orca profile state rollback --revision 1',
      'orca profile state rollback --latest-json',
      'orca profile state rollback --current-json',
      'orca profile state rollback --current-sqlite'
    ]
  }
]
