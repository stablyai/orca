import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { wslHostsWithReopenedWork } from './wsl-host-reopened-work'

const UBUNTU_HOST = 'runtime:wsl%3Aubuntu'

function storeWith(sessions: Record<string, Partial<WorkspaceSessionState>>) {
  return {
    getWorkspaceSession: (hostId?: string | null): WorkspaceSessionState => ({
      ...getDefaultWorkspaceSession(),
      ...sessions[hostId ?? 'local']
    })
  }
}

describe('wslHostsWithReopenedWork', () => {
  it('reopens the host that owns the active workspace', () => {
    const store = storeWith({ local: { activeWorkspaceExecutionHostId: UBUNTU_HOST } })
    expect(wslHostsWithReopenedWork(store, ['wsl:ubuntu', 'wsl:debian'])).toEqual(['wsl:ubuntu'])
  })

  it('reopens a host whose saved partition still has a terminal tab', () => {
    const store = storeWith({
      [UBUNTU_HOST]: {
        tabsByWorktree: {
          'repo::/home/me/app': [
            {
              id: 'tab-1',
              ptyId: null,
              worktreeId: 'repo::/home/me/app',
              title: 'bash',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 0
            }
          ]
        }
      }
    })
    expect(wslHostsWithReopenedWork(store, ['wsl:ubuntu'])).toEqual(['wsl:ubuntu'])
  })

  it('leaves hosts with no open work stopped', () => {
    const store = storeWith({ [UBUNTU_HOST]: { tabsByWorktree: { 'repo::/home/me/app': [] } } })
    expect(wslHostsWithReopenedWork(store, ['wsl:ubuntu'])).toEqual([])
  })
})
