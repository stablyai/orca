import { describe, expect, it } from 'vitest'
import {
  buildWorkspaceDirHistoryForUpdate,
  migrateAgentYoloDefaults
} from './terminal-settings-migrations'

describe('migrateAgentYoloDefaults', () => {
  it('keeps newly added agent defaults manual for already migrated profiles', () => {
    const migrated = migrateAgentYoloDefaults({
      agentYoloDefaultsMigrated: true,
      agentDefaultArgs: { claude: '--dangerously-skip-permissions' },
      agentDefaultEnv: {}
    })

    expect(migrated.agentDefaultArgs?.droid).toBe('')
    expect(migrated.agentDefaultEnv?.goose).toEqual({})
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

describe('buildWorkspaceDirHistoryForUpdate', () => {
  it('does not normalize or record a corrupt current workspace path', () => {
    const current = {
      workspaceDir: undefined,
      nestWorkspaces: false,
      workspaceDirHistory: [{ path: '/old/workspaces', nestWorkspaces: false }]
    }

    expect(
      buildWorkspaceDirHistoryForUpdate(current, {
        workspaceDir: '/new/workspaces'
      })
    ).toBeNull()
  })

  it('does not record a whitespace-only current workspace path', () => {
    const current = {
      workspaceDir: '   ',
      nestWorkspaces: false,
      workspaceDirHistory: [{ path: '/old/workspaces', nestWorkspaces: false }]
    }

    expect(
      buildWorkspaceDirHistoryForUpdate(current, {
        workspaceDir: '/new/workspaces'
      })
    ).toBeNull()
  })

  it('filters corrupt history before recording the previous valid layout', () => {
    const current = {
      workspaceDir: '/current/workspaces',
      nestWorkspaces: false,
      workspaceDirHistory: [
        null,
        { path: '', nestWorkspaces: true },
        { path: 42, nestWorkspaces: false },
        { path: '/old/workspaces', nestWorkspaces: true }
      ]
    }

    expect(
      buildWorkspaceDirHistoryForUpdate(current, {
        workspaceDir: '/new/workspaces'
      })
    ).toEqual([
      { path: '/old/workspaces', nestWorkspaces: true },
      { path: '/current/workspaces', nestWorkspaces: false }
    ])
  })
})
