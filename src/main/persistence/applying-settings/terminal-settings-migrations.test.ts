import { describe, expect, it } from 'vitest'
import { migrateAgentYoloDefaults, migrateDshAgentPermission } from './terminal-settings-migrations'

describe('migrateAgentYoloDefaults', () => {
  it('keeps newly added agent defaults manual for already migrated profiles', () => {
    const migrated = migrateAgentYoloDefaults({
      agentYoloDefaultsMigrated: true,
      agentDefaultArgs: { claude: '--dangerously-skip-permissions' },
      agentDefaultEnv: {}
    } as never)

    expect(migrated.agentDefaultArgs?.droid).toBe('')
    expect(migrated.agentDefaultEnv?.goose).toEqual({})
    expect(migrated.agentDefaultEnv?.dsh).toEqual({})
  })

  it('does not overwrite an existing DSH permission or env in a migrated profile', () => {
    const custom = { DSH_PERMISSION_MODE: 'workspace-write', DSH_TUI_THEME: 'dark' }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This test only supplies the settings fields consumed by this migration.
    const migrated = migrateAgentYoloDefaults({
      agentYoloDefaultsMigrated: true,
      agentDefaultArgs: {},
      agentDefaultEnv: { dsh: custom }
    } as never)

    expect(migrated.agentDefaultEnv?.dsh).toEqual(custom)
  })

  it('updates the previous Devin default for existing profiles', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This test only supplies the settings fields consumed by this migration.
    const migrated = migrateAgentYoloDefaults({
      agentYoloDefaultsMigrated: true,
      agentDefaultArgs: { devin: '--permission-mode bypass' },
      agentDefaultEnv: {}
    } as never)

    expect(migrated.agentDefaultArgs?.devin).toBe(
      '--permission-mode bypass --respect-workspace-trust false'
    )
  })
})

describe('migrateDshAgentPermission', () => {
  it('keeps DSH on its own settings for typed profiles saved before DSH joined', () => {
    const migrated = migrateDshAgentPermission(
      { agentPermissionDefault: 'full-access', agentPermissionOverrides: {} },
      true
    )

    expect(migrated.agentPermissionOverrides).toEqual({ dsh: 'own' })
    expect(migrated.dshAgentPermissionMigrated).toBe(true)
  })

  it('keeps an explicit DSH choice and unrelated overrides', () => {
    const migrated = migrateDshAgentPermission(
      {
        agentPermissionDefault: 'full-access',
        agentPermissionOverrides: { dsh: 'full-access', claude: 'ask' }
      },
      true
    )

    expect(migrated.agentPermissionOverrides).toEqual({
      dsh: 'full-access',
      claude: 'ask'
    })
  })

  it('adds nothing when the all-agents choice already leaves DSH manual', () => {
    const migrated = migrateDshAgentPermission(
      { agentPermissionDefault: 'own', agentPermissionOverrides: {} },
      true
    )

    expect(migrated.agentPermissionOverrides).toEqual({})
  })

  it('does not touch an already stamped or untyped profile', () => {
    expect(
      migrateDshAgentPermission(
        {
          agentPermissionDefault: 'full-access',
          agentPermissionOverrides: {},
          dshAgentPermissionMigrated: true
        },
        true
      ).agentPermissionOverrides
    ).toEqual({})
    expect(
      migrateDshAgentPermission(
        { agentPermissionDefault: 'full-access', agentPermissionOverrides: {} },
        false
      ).agentPermissionOverrides
    ).toEqual({})
  })
})
