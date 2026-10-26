import { describe, expect, it } from 'vitest'
import { orcadMigrationConflictGuidance } from './orcad-migration-conflict-guidance'

const NO_DESKTOP_STEP = [
  'project_group_id',
  'folder_workspace_id',
  'dormant_id',
  'dormant_focus',
  'client_state',
  'close_intent_destination',
  'snapshot_destination'
]

describe('orcad migration conflict guidance', () => {
  // This guidance also reaches clients without a plain SSH terminal.
  it('names the code for every conflict retrying can’t clear, and no client-only action', () => {
    for (const kind of NO_DESKTOP_STEP) {
      const text = orcadMigrationConflictGuidance(
        new Error(`orcad_migration_${kind}_conflict:ui:workspaceHostScope`)
      )
      expect(text).toContain('Retrying won’t clear it.')
      expect(text).not.toContain('plain SSH')
      expect(text).toContain(`orcad_migration_${kind}_conflict`)
    }
  })

  it('keeps the specific way out where the desktop has one', () => {
    expect(
      orcadMigrationConflictGuidance(
        new Error('orcad_migration_repository_path_conflict:/home/me/app')
      )
    ).toContain('remove that project from this desktop and connect again')
  })

  it('is null for anything that is not a conflict', () => {
    expect(orcadMigrationConflictGuidance(new Error('ECONNRESET'))).toBeNull()
  })
})
