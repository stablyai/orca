import { describe, expect, it } from 'vitest'
import { sshExecutionHostStorageIdentity } from './browser-execution-host-storage-identity'
import {
  deriveBrowserRoutePartition,
  deriveBrowserRoutePartitionStorageScope,
  deriveLocalSshBrowserRoutePartitionStorageScope
} from './browser-route-identity'
import { localSshBrowserAuthorityConnectionIdentity } from './local-ssh-browser-partitions'

function derive(orcaProfileId: string, browserProfileId: string, targetId: string) {
  return deriveBrowserRoutePartition({
    orcaProfileId,
    browserProfileId,
    authorityConnectionIdentity: localSshBrowserAuthorityConnectionIdentity(orcaProfileId),
    executionHostIdentity: sshExecutionHostStorageIdentity(targetId)
  })
}

describe('local ssh browser partition identity', () => {
  it('pins the golden partition so no per-boot value can sneak into the name', () => {
    // Changing this cookie-storage identity requires a migration.
    expect(derive('local-default', 'default', 'ssh-target-1').partition).toBe(
      'persist:orca-browser-v1-5bd50510715cb753c62637e02be1e3e480ce8a5b1d8fc5d8b71205a2ff6181a4'
    )
  })

  it('derives one stable partition per (profile, target) and separates each axis', () => {
    const base = derive('local-default', 'default', 'ssh-target-1')
    expect(derive('local-default', 'default', 'ssh-target-1')).toEqual(base)
    expect(derive('local-default', 'default', 'ssh-target-2').partition).not.toBe(base.partition)
    expect(derive('local-default', 'session-a', 'ssh-target-1').partition).not.toBe(base.partition)
    expect(derive('profile-b', 'default', 'ssh-target-1').partition).not.toBe(base.partition)
  })

  it('separates the local-ssh storage scope domain from environment scopes', () => {
    expect(
      deriveLocalSshBrowserRoutePartitionStorageScope({
        orcaProfileId: 'local-default',
        targetId: 'same-id'
      })
    ).not.toBe(
      deriveBrowserRoutePartitionStorageScope({
        orcaProfileId: 'local-default',
        environmentId: 'same-id'
      })
    )
  })
})
