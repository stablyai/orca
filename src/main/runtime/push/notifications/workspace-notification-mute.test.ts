import { describe, expect, it } from 'vitest'
import { getDefaultUIState } from '../../../../shared/constants'
import type { PersistedUIState } from '../../../../shared/persisted-ui-state-types'
import {
  isWorkspaceNotificationMuted,
  type WorkspaceNotificationMuteDeps
} from './workspace-notification-mute'

function deps(ui: Partial<PersistedUIState>): WorkspaceNotificationMuteDeps {
  return {
    store: {
      getUI: () => ({ ...getDefaultUIState(), ...ui }),
      getRepo: () => undefined,
      getWorktreeMeta: () => undefined,
      getAllWorktreeLineage: () => ({}),
      getFolderWorkspaces: () => [],
      getSettings: () => ({})
    },
    resolvedWorktrees: null
  }
}

describe('isWorkspaceNotificationMuted', () => {
  it('mutes host phone pushes for a worktree the user muted', () => {
    const muted = deps({
      notificationsMutedByWorktree: { 'repo-1::/wt': true }
    })
    expect(isWorkspaceNotificationMuted(muted, 'repo-1::/wt')).toBe(true)
    expect(isWorkspaceNotificationMuted(muted, 'repo-1::/other')).toBe(false)
  })

  it('mutes a folder workspace by its sidebar id', () => {
    const muted = deps({
      notificationsMutedByWorktree: { 'folder:fw-1': true }
    })
    expect(isWorkspaceNotificationMuted(muted, 'folder:fw-1')).toBe(true)
  })

  it('leaves workspaces unmuted when nothing is persisted', () => {
    expect(isWorkspaceNotificationMuted(deps({}), 'repo-1::/wt')).toBe(false)
  })
})
