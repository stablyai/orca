import { describe, expect, it } from 'vitest'
import { buildLocalNotificationData, getNotificationNavigationPath } from './notification-routing'

describe('notification routing', () => {
  it('includes the host id in locally scheduled notification data', () => {
    expect(
      buildLocalNotificationData(
        {
          source: 'agent-task-complete',
          worktreeId: 'repo::/Users/me/orca/workspaces/feature'
        },
        'host-1'
      )
    ).toEqual({
      source: 'agent-task-complete',
      hostId: 'host-1',
      worktreeId: 'repo::/Users/me/orca/workspaces/feature'
    })
  })

  it('routes notification taps to the worktree terminal screen', () => {
    expect(
      getNotificationNavigationPath({
        hostId: 'host-1',
        worktreeId: 'repo::/Users/me/orca/workspaces/feature'
      })
    ).toBe('/h/host-1/session/repo%3A%3A%2FUsers%2Fme%2Forca%2Fworkspaces%2Ffeature')
  })

  it('falls back to the host screen when the payload has no worktree id', () => {
    expect(getNotificationNavigationPath({ hostId: 'host-1' })).toBe('/h/host-1')
  })

  it('ignores payloads that cannot identify the paired host', () => {
    expect(getNotificationNavigationPath({ worktreeId: 'repo::/tmp/worktree' })).toBeNull()
  })

  it('ignores payloads for hosts that are no longer paired', () => {
    expect(
      getNotificationNavigationPath(
        { hostId: 'removed-host', worktreeId: 'repo::/tmp/worktree' },
        { knownHostIds: new Set(['host-1']) }
      )
    ).toBeNull()
  })
})
