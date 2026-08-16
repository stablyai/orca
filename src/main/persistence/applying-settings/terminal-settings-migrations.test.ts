import { describe, expect, it } from 'vitest'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { buildWorkspaceDirHistoryForUpdate } from './terminal-settings-migrations'

function makeSettings(
  values: Pick<GlobalSettings, 'workspaceDir' | 'nestWorkspaces' | 'workspaceDirHistory'>
): GlobalSettings {
  return values as GlobalSettings
}

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

  it('filters corrupt history before recording the previous valid layout', () => {
    const current = makeSettings({
      workspaceDir: '/current/workspaces',
      nestWorkspaces: false,
      workspaceDirHistory: [
        null as never,
        { path: '', nestWorkspaces: true },
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
