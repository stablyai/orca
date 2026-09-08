import { describe, expect, it } from 'vitest'
import {
  buildLocalNotificationData,
  getNotificationNavigationPath,
  getNotificationNavigationTarget,
  LatestNotificationNavigationResolver,
  resolveNotificationNavigation,
  type NotificationKnownHost
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

  it('routes notification taps to the worktree terminal screen', () => {
    expect(
      getNotificationNavigationTarget({
        hostId: 'host-1',
        worktreeId: 'repo::/Users/me/orca/workspaces/feature'
      })
    ).toEqual({
      kind: 'session',
      hostId: 'host-1',
      hostWorkspaceId: 'repo::/Users/me/orca/workspaces/feature'
    })
    expect(
      getNotificationNavigationPath({
        hostId: 'host-1',
        worktreeId: 'repo::/Users/me/orca/workspaces/feature'
      })
    ).toBe('/h/host-1/session/repo%3A%3A%2FUsers%2Fme%2Forca%2Fworkspaces%2Ffeature')
  })

  it('falls back to the host screen when the payload has no worktree id', () => {
    expect(getNotificationNavigationTarget({ hostId: 'host-1' })).toEqual({
      kind: 'host',
      hostId: 'host-1'
    })
    expect(getNotificationNavigationPath({ hostId: 'host-1' })).toBe('/h/host-1')
  })

  it('preserves credential recovery for notification taps', () => {
    const options = {
      knownHostIds: new Set(['missing', 'offline']),
      credentialStatusByHostId: new Map([
        ['missing', 'missing' as const],
        ['offline', 'temporarily-unavailable' as const]
      ])
    }
    expect(getNotificationNavigationTarget({ hostId: 'missing' }, options)).toEqual({
      kind: 'host',
      hostId: 'missing',
      credentialRecovery: 're-pair'
    })
    expect(
      getNotificationNavigationTarget({ hostId: 'offline', worktreeId: 'workspace' }, options)
    ).toEqual({
      kind: 'session',
      hostId: 'offline',
      hostWorkspaceId: 'workspace',
      credentialRecovery: 'retry'
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

  it('rejects unbounded identifiers before they can enter native or hosted routing', () => {
    expect(getNotificationNavigationTarget({ hostId: 'h'.repeat(513) })).toBeNull()
    expect(
      getNotificationNavigationTarget({ hostId: 'host-1', worktreeId: 'w'.repeat(513) })
    ).toBeNull()
  })

  it('rejects malformed workspace identity instead of downgrading it to a host route', () => {
    expect(getNotificationNavigationTarget({ hostId: 'host-1', worktreeId: 42 })).toBeNull()
    expect(getNotificationNavigationTarget({ hostId: 'host-1', worktreeId: {} })).toBeNull()
  })

  it('fails closed when paired-host storage cannot validate a notification', async () => {
    await expect(
      resolveNotificationNavigation({ hostId: 'host-1' }, async () => {
        throw new Error('storage unavailable')
      })
    ).resolves.toBeNull()
  })

  it('resolves a validated host and workspace once into a consistent navigation result', async () => {
    await expect(
      resolveNotificationNavigation(
        { hostId: 'host-1', worktreeId: 'repo::/tmp/worktree' },
        async () => [{ id: 'host-1', credentialStatus: 'ready' as const }]
      )
    ).resolves.toEqual({
      target: {
        kind: 'session',
        hostId: 'host-1',
        hostWorkspaceId: 'repo::/tmp/worktree'
      },
      path: '/h/host-1/session/repo%3A%3A%2Ftmp%2Fworktree'
    })
  })

  it('routes a host with unreadable credentials to recovery instead of dropping the tap', async () => {
    await expect(
      resolveNotificationNavigation({ hostId: 'host-1', worktreeId: 'workspace-one' }, async () => [
        { id: 'host-1', credentialStatus: 'temporarily-unavailable' as const }
      ])
    ).resolves.toMatchObject({ target: { credentialRecovery: 'retry' } })
    await expect(
      resolveNotificationNavigation({ hostId: 'host-1' }, async () => [
        { id: 'host-1', credentialStatus: 'missing' as const }
      ])
    ).resolves.toMatchObject({ target: { credentialRecovery: 're-pair' } })
  })

  it('suppresses an older tap whose paired-host read finishes after a newer tap', async () => {
    const firstHosts = deferred<readonly NotificationKnownHost[]>()
    const secondHosts = deferred<readonly NotificationKnownHost[]>()
    const resolver = new LatestNotificationNavigationResolver()
    const first = resolver.resolve(
      { hostId: 'host-1', worktreeId: 'workspace-one' },
      () => firstHosts.promise
    )
    const second = resolver.resolve(
      { hostId: 'host-1', worktreeId: 'workspace-two' },
      () => secondHosts.promise
    )

    secondHosts.resolve([{ id: 'host-1', credentialStatus: 'ready' }])
    await expect(second).resolves.toMatchObject({
      target: { kind: 'session', hostWorkspaceId: 'workspace-two' }
    })
    firstHosts.resolve([{ id: 'host-1', credentialStatus: 'ready' }])
    await expect(first).resolves.toBeNull()
  })
})

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve = (_value: T): void => {}
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}
