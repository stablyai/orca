import { describe, expect, it } from 'vitest'
import {
  buildLocalNotificationData,
  getNotificationNavigationTarget,
  notificationCredentialRecoveryRoute
} from './notification-routing'

describe('notification routing', () => {
  it('includes the host id in locally scheduled notification data', () => {
    expect(
      buildLocalNotificationData(
        {
          source: 'agent-task-complete',
          worktreeId: 'repo::/Users/me/orca/workspaces/feature',
          notificationId: 'agent:one'
        },
        'host-1'
      )
    ).toEqual({
      source: 'agent-task-complete',
      hostId: 'host-1',
      worktreeId: 'repo::/Users/me/orca/workspaces/feature',
      notificationId: 'agent:one'
    })
  })

  // Identities stay raw: the target is dispatched as navigator params, not a URL.
  it('routes notification taps to the worktree terminal screen', () => {
    expect(
      getNotificationNavigationTarget({
        hostId: 'host-1',
        worktreeId: 'repo::/Users/me/orca/workspaces/feature'
      })
    ).toEqual({
      hostId: 'host-1',
      sessionTarget: {
        name: '[hostId]/session/[worktreeId]',
        params: { hostId: 'host-1', worktreeId: 'repo::/Users/me/orca/workspaces/feature' }
      }
    })
  })

  it('falls back to the host screen when the payload has no worktree id', () => {
    expect(getNotificationNavigationTarget({ hostId: 'host-1' })).toEqual({
      hostId: 'host-1',
      sessionTarget: null
    })
  })

  it('ignores payloads that cannot identify the paired host', () => {
    expect(getNotificationNavigationTarget({ worktreeId: 'repo::/tmp/worktree' })).toBeNull()
  })

  it('ignores payloads for hosts that are no longer paired', () => {
    expect(
      getNotificationNavigationTarget(
        { hostId: 'removed-host', worktreeId: 'repo::/tmp/worktree' },
        { knownHostIds: new Set(['host-1']) }
      )
    ).toBeNull()
  })

  it.each([
    ['missing', 're-pair'],
    ['temporarily-unavailable', 'retry']
  ] as const)('routes %s host credentials to %s recovery', (status, recovery) => {
    const target = getNotificationNavigationTarget(
      { hostId: 'host-1', worktreeId: 'repo::/tmp/worktree' },
      {
        knownHostIds: new Set(['host-1']),
        credentialStatusByHostId: new Map([['host-1', status]])
      }
    )

    expect(target).toMatchObject({ hostId: 'host-1', credentialRecovery: recovery })
    expect(notificationCredentialRecoveryRoute(target!)).toBe(
      status === 'missing' ? '/pair-scan' : '/'
    )
  })

  it('keeps ready hosts on the requested notification destination', () => {
    const target = getNotificationNavigationTarget(
      { hostId: 'host-1', worktreeId: 'repo::/tmp/worktree' },
      { credentialStatusByHostId: new Map([['host-1', 'ready']]) }
    )

    expect(target?.sessionTarget).not.toBeNull()
    expect(notificationCredentialRecoveryRoute(target!)).toBeNull()
  })
})
