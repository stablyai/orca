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
    // Why: cookies live under this exact name; ANY drift in the identity
    // composition silently logs every SSH workspace out. Recompute only for a
    // deliberate, migration-accompanied identity change.
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
    // Why: an environment id equal to a target id must never make one owner's
    // removal clear the other owner's cookie jars.
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

  it('keeps the storage identity aligned with the paired nested-SSH identity', () => {
    // Why: both owners key SSH storage by ['ssh', targetId]; alignment means a
    // future unification cannot strand a jar under a mismatched identity. Full
    // golden string — a dropped domain tag must fail, not pass by substring.
    expect(sshExecutionHostStorageIdentity('t-1')).toBe(
      '["orca-browser-execution-host-storage",1,"ssh","t-1"]'
    )
  })
})
