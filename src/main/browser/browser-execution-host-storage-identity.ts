import type { BrowserNetworkExecutionHost } from '../../shared/browser-client-host-protocol'

const STORAGE_IDENTITY_VERSION = 1
const STORAGE_IDENTITY_TAG = 'orca-browser-execution-host-storage'

/**
 * Storage identity of an execution host: the components that must keep browser
 * storage attached to the same partition.
 *
 * This is deliberately narrower than `browserNetworkExecutionHostKey`, which is
 * the route/tunnel fencing key. The fencing key embeds per-boot values (native
 * and WSL `revision` = the runtime's start time, SSH `connectionGeneration` and
 * `providerEpoch`); hashing those into the partition name minted a fresh
 * Chromium partition on every runtime restart or SSH reconnect and silently
 * dropped cookies and localStorage.
 *
 * `runtimeId` is per-process too -- `OrcaRuntimeService` mints it with
 * `randomUUID()` at construction and elsewhere pairs it with `pid` as a
 * process-ownership token -- so native and WSL hosts name their machine by
 * `authorityStorageKey`, the client's durable record of the paired server.
 *
 * Non-reusable record identity is preserved: a deleted-and-readded SSH target
 * gets a freshly minted `targetId`, and a removed-and-repaired environment gets
 * a fresh storage key, so neither inherits the previous record's storage.
 */
export function browserNetworkExecutionHostStorageIdentity(
  host: BrowserNetworkExecutionHost,
  authorityStorageKey: string
): string {
  if (host.kind === 'native') {
    return browserAuthorityExecutionHostStorageIdentity(authorityStorageKey)
  }
  if (host.kind === 'wsl') {
    return storageIdentity(['authority-wsl', authorityStorageKey, host.distro])
  }
  // Why: providerEpoch is a per-connection fencing nonce reissued on every
  // reconnect, not a persistent record id -- targetId already carries non-reuse.
  return storageIdentity(['ssh', host.targetId])
}

/** Storage identity of an SSH target, for local direct-SSH callers with no authority record. */
export function sshExecutionHostStorageIdentity(targetId: string): string {
  return storageIdentity(['ssh', targetId])
}

/** Storage identity of the paired server's own machine, for callers with no execution-host record. */
export function browserAuthorityExecutionHostStorageIdentity(authorityStorageKey: string): string {
  return storageIdentity(['authority', authorityStorageKey])
}

/**
 * Pre-migration identities, keyed by the authority's per-process `runtimeId`.
 *
 * Only `browserRoutePartitionMigration` uses these: they name the partition an
 * older build already put the user's cookies in, so the current identity can
 * adopt it instead of stranding a logged-in jar.
 */
export function legacyBrowserNetworkExecutionHostStorageIdentity(
  host: BrowserNetworkExecutionHost
): string {
  if (host.kind === 'native') {
    return legacyBrowserNativeExecutionHostStorageIdentity(host.runtimeId)
  }
  if (host.kind === 'wsl') {
    return storageIdentity(['wsl', host.runtimeId, host.distro])
  }
  return storageIdentity(['ssh', host.targetId])
}

export function legacyBrowserNativeExecutionHostStorageIdentity(runtimeId: string): string {
  return storageIdentity(['native', runtimeId])
}

function storageIdentity(components: readonly string[]): string {
  return JSON.stringify([STORAGE_IDENTITY_TAG, STORAGE_IDENTITY_VERSION, ...components])
}
