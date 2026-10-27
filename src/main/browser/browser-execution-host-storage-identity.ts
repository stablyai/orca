import type { BrowserNetworkExecutionHost } from '../../shared/browser-network-execution-host'

const STORAGE_IDENTITY_VERSION = 1
const STORAGE_IDENTITY_TAG = 'orca-browser-execution-host-storage'

/** Persist storage across reconnects; route fencing keys contain per-boot values. */
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
  // Durable record IDs change on re-pair/re-add; connection epochs must not change storage.
  return storageIdentity(['ssh', host.targetId])
}

export function sshExecutionHostStorageIdentity(targetId: string): string {
  return storageIdentity(['ssh', targetId])
}

export function browserAuthorityExecutionHostStorageIdentity(authorityStorageKey: string): string {
  return storageIdentity(['authority', authorityStorageKey])
}

/** Names older partitions for cookie adoption during migration. */
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
