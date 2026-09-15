import { describe, expect, it } from 'vitest'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import {
  buildWorkspaceDirHistoryForUpdate,
  migrateAgentYoloDefaults
} from './terminal-settings-migrations'

function makeSettings(
  values: Pick<GlobalSettings, 'workspaceDir' | 'nestWorkspaces' | 'workspaceDirHistory'>
): GlobalSettings {
  return values as GlobalSettings
}

describe('migrateAgentYoloDefaults', () => {
  it('keeps newly added agent defaults manual for already migrated profiles', () => {
    const migrated = migrateAgentYoloDefaults({
      agentYoloDefaultsMigrated: true,
      agentDefaultArgs: { claude: '--dangerously-skip-permissions' },
      agentDefaultEnv: {}
    } as never)

    expect(migrated.agentDefaultArgs?.droid).toBe('')
    expect(migrated.agentDefaultEnv?.goose).toEqual({})
  })
})

describe('buildWorkspaceDirHistoryForUpdate', () => {
  it('does not normalize or record a corrupt current workspace path', () => {
    const current = makeSettings({
      workspaceDir: undefined as unknown as string,
      nestWorkspaces: false,
      workspaceDirHistory: [{ path: '/old/workspaces', nestWorkspaces: false }]
    })

    expect(
      buildWorkspaceDirHistoryForUpdate(current, {
        workspaceDir: '/new/workspaces'
      })
    ).toBeNull()
  })

  it('does not record a whitespace-only current workspace path', () => {
    const current = makeSettings({
      workspaceDir: '   ',
      nestWorkspaces: false,
      workspaceDirHistory: [{ path: '/old/workspaces', nestWorkspaces: false }]
    })

    expect(
      buildWorkspaceDirHistoryForUpdate(current, {
        workspaceDir: '/new/workspaces'
      })
    ).toBeNull()
  })

  it('filters corrupt history before recording the previous valid layout', () => {
    const current = makeSettings({
      workspaceDir: '/current/workspaces',
      nestWorkspaces: false,
      workspaceDirHistory: [
        null as never,
        { path: '', nestWorkspaces: true },
        { path: 42 as unknown as string, nestWorkspaces: false },
        { path: '/old/workspaces', nestWorkspaces: true }
      ]
    })

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
