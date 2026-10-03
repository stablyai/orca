import { describe, expect, it } from 'vitest'
import { migrateAgentYoloDefaults } from './terminal-settings-migrations'

describe('migrateAgentYoloDefaults', () => {
  it('inherits yolo mode for newly added agents on already migrated yolo profiles', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This test only supplies the settings fields consumed by this migration.
    const migrated = migrateAgentYoloDefaults({
      agentYoloDefaultsMigrated: true,
      agentDefaultArgs: { claude: '--dangerously-skip-permissions' },
      agentDefaultEnv: {}
    } as never)

    expect(migrated.agentDefaultArgs?.droid).toBe('--auto high')
    expect(migrated.agentDefaultArgs?.muse).toBe('--yolo')
    expect(migrated.agentDefaultEnv?.goose).toEqual({ GOOSE_MODE: 'auto' })
  })

  it('keeps newly added agent defaults manual for already migrated manual profiles', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This test only supplies the settings fields consumed by this migration.
    const migrated = migrateAgentYoloDefaults({
      agentYoloDefaultsMigrated: true,
      agentDefaultArgs: { claude: '' },
      agentDefaultEnv: {}
    } as never)

    expect(migrated.agentDefaultArgs?.droid).toBe('')
    expect(migrated.agentDefaultArgs?.muse).toBe('')
    expect(migrated.agentDefaultEnv?.goose).toEqual({})
  })

  it('keeps newly added agent defaults manual for already migrated mixed profiles', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This test only supplies the settings fields consumed by this migration.
    const migrated = migrateAgentYoloDefaults({
      agentYoloDefaultsMigrated: true,
      agentDefaultArgs: { claude: '--dangerously-skip-permissions', codex: '' },
      agentDefaultEnv: {}
    } as never)

    expect(migrated.agentDefaultArgs?.droid).toBe('')
    expect(migrated.agentDefaultArgs?.muse).toBe('')
    expect(migrated.agentDefaultEnv?.goose).toEqual({})
  })

  it('repairs muse and other backfilled defaults to yolo when existing profile is otherwise in yolo mode', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This test only supplies the settings fields consumed by this migration.
    const migrated = migrateAgentYoloDefaults({
      agentYoloDefaultsMigrated: true,
      agentDefaultArgs: {
        claude: '--dangerously-skip-permissions',
        codex: '--dangerously-bypass-approvals-and-sandbox',
        ante: '',
        devin: '',
        trae: '',
        droid: '',
        muse: '',
        zcode: ''
      },
      agentDefaultEnv: {
        goose: {}
      }
    } as never)

    expect(migrated.agentDefaultArgs?.ante).toBe('--yolo')
    expect(migrated.agentDefaultArgs?.devin).toBe(
      '--permission-mode bypass --respect-workspace-trust false'
    )
    expect(migrated.agentDefaultArgs?.trae).toBe('--yolo')
    expect(migrated.agentDefaultArgs?.droid).toBe('--auto high')
    expect(migrated.agentDefaultArgs?.muse).toBe('--yolo')
    expect(migrated.agentDefaultArgs?.zcode).toBe('--mode yolo')
    expect(migrated.agentDefaultEnv?.goose).toEqual({ GOOSE_MODE: 'auto' })
  })

  it('repairs backfilled defaults when env was already yolo', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This test only supplies the settings fields consumed by this migration.
    const migrated = migrateAgentYoloDefaults({
      agentYoloDefaultsMigrated: true,
      agentDefaultArgs: {
        claude: '--dangerously-skip-permissions',
        codex: '--dangerously-bypass-approvals-and-sandbox',
        droid: '',
        muse: ''
      },
      agentDefaultEnv: {
        goose: { GOOSE_MODE: 'auto' }
      }
    } as never)

    expect(migrated.agentDefaultArgs?.droid).toBe('--auto high')
    expect(migrated.agentDefaultArgs?.muse).toBe('--yolo')
  })

  it('preserves manual muse default when profile is in manual mode', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This test only supplies the settings fields consumed by this migration.
    const migrated = migrateAgentYoloDefaults({
      agentYoloDefaultsMigrated: true,
      agentDefaultArgs: {
        claude: '',
        codex: '',
        muse: ''
      },
      agentDefaultEnv: {}
    } as never)

    expect(migrated.agentDefaultArgs?.muse).toBe('')
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

  it('does not overwrite intentional manual defaults when backfill has already been repaired', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This test only supplies the settings fields consumed by this migration.
    const migrated = migrateAgentYoloDefaults({
      agentYoloDefaultsMigrated: true,
      agentYoloDefaultsBackfillRepaired: true,
      agentDefaultArgs: {
        claude: '--dangerously-skip-permissions',
        codex: '--dangerously-bypass-approvals-and-sandbox',
        muse: ''
      },
      agentDefaultEnv: {
        goose: {}
      }
    } as never)

    expect(migrated.agentDefaultArgs?.muse).toBe('')
    expect(migrated.agentDefaultEnv?.goose).toEqual({})
    expect(migrated.agentYoloDefaultsBackfillRepaired).toBe(true)
  })

  it('preserves command override ownership for missing agents in already-migrated yolo profiles', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This test only supplies the settings fields consumed by this migration.
    const migrated = migrateAgentYoloDefaults({
      agentYoloDefaultsMigrated: true,
      agentDefaultArgs: {
        claude: '--dangerously-skip-permissions'
      },
      agentDefaultEnv: {},
      agentCmdOverrides: {
        muse: '/custom/bin/muse',
        goose: '/custom/bin/goose'
      }
    } as never)

    expect(migrated.agentDefaultArgs?.muse).toBe('')
    expect(migrated.agentDefaultEnv?.goose).toEqual({})
    expect(migrated.agentDefaultArgs?.droid).toBe('--auto high')
  })
})
