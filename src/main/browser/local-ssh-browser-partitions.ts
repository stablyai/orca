import { app, session, webContents, type Session, type WebContents } from 'electron'
import { closeRouteGuest } from './browser-route-guest-guard'
import { sshExecutionHostStorageIdentity } from './browser-execution-host-storage-identity'
import {
  deriveBrowserRoutePartition,
  deriveLocalSshBrowserRoutePartitionStorageScope
} from './browser-route-identity'
import {
  activeBrowserRoutePartitionOrcaProfileId,
  currentBrowserRoutePartitionBindingStore
} from './browser-route-partition-binding-runtime'
import {
  isBrowserRoutePartitionRetainedByAnyOwner,
  registerBrowserRoutePartitionRetentionProbe
} from './browser-route-partition-retention'
import { releaseEvictedBrowserRoutePartitionStorage } from './browser-route-partition-storage-dependencies'
import {
  prepareBrowserRouteSessionPolicy,
  type BrowserRouteProxyEndpoint
} from './browser-route-session-policy'
import { enforceBrowserRouteWebRtcPolicy } from './browser-route-webrtc-policy'
import { browserSessionRegistry } from './browser-session-registry'
import {
  closeLocalSshBrowserRouteForTarget,
  probeLocalSshBrowserRouteForwarding,
  retainLocalSshBrowserRoute
} from './local-ssh-browser-route'

const AUTHORITY_CONNECTION_IDENTITY_TAG = 'orca-local-ssh-browser'
const AUTHORITY_CONNECTION_IDENTITY_VERSION = 1

type PreparedLocalSshPartition = {
  partition: string
  targetId: string
  browserProfileId: string
  proxyEndpoint: BrowserRouteProxyEndpoint
}

type PendingLocalSshPartition = {
  targetId: string
  promise: Promise<PreparedLocalSshPartition>
}

const preparedByIdentityKey = new Map<string, PendingLocalSshPartition>()
const preparedByPartition = new Map<string, PreparedLocalSshPartition>()
const partitionBySession = new WeakMap<Session, string>()

// Keep the identity stable across restarts to preserve cookies.
export function localSshBrowserAuthorityConnectionIdentity(orcaProfileId: string): string {
  return JSON.stringify([
    AUTHORITY_CONNECTION_IDENTITY_TAG,
    AUTHORITY_CONNECTION_IDENTITY_VERSION,
    orcaProfileId
  ])
}

export function isLocalSshBrowserPartition(partition: string): boolean {
  return preparedByPartition.has(partition)
}

export function localSshBrowserPartitionForSession(webSession: Session): string | null {
  return partitionBySession.get(webSession) ?? null
}

export function localSshBrowserTargetIdForSession(webSession: Session): string | null {
  const partition = partitionBySession.get(webSession)
  return partition ? (preparedByPartition.get(partition)?.targetId ?? null) : null
}

// Verify the proxy before exposing the partition to the renderer.
export async function prepareLocalSshBrowserPartition(input: {
  targetId: string
  browserProfileId: string
  /** The error card's "Try anyway" bypasses the forwarding probe. */
  skipProbe?: boolean
}): Promise<{ partition: string }> {
  // Keep skipped probes separate so "Check again" cannot reuse a bypassed success.
  const identityKey = JSON.stringify([
    input.targetId,
    input.browserProfileId,
    input.skipProbe === true
  ])
  let pending = preparedByIdentityKey.get(identityKey)
  if (!pending) {
    const promise = prepareFresh(input)
    pending = { targetId: input.targetId, promise }
    preparedByIdentityKey.set(identityKey, pending)
    promise.catch(() => {
      if (preparedByIdentityKey.get(identityKey) === pending) {
        preparedByIdentityKey.delete(identityKey)
      }
    })
  }
  const prepared = await pending.promise
  return { partition: prepared.partition }
}

async function prepareFresh(input: {
  targetId: string
  browserProfileId: string
  skipProbe?: boolean
}): Promise<PreparedLocalSshPartition> {
  const orcaProfileId = activeBrowserRoutePartitionOrcaProfileId()
  if (!orcaProfileId) {
    throw new Error('browser_local_route_profile_unavailable')
  }
  browserSessionRegistry.requireRouteBrowserProfile(input.browserProfileId)
  const proxyEndpoint = await retainLocalSshBrowserRoute(input.targetId)
  if (!input.skipProbe) {
    // Explain disabled TCP forwarding before pages fail with opaque SOCKS errors.
    const verdict = await probeLocalSshBrowserRouteForwarding(input.targetId)
    if (verdict === 'forwarding-blocked') {
      throw new Error('browser_local_route_forwarding_blocked')
    }
    if (verdict === 'ssh-unavailable') {
      throw new Error('browser_local_route_ssh_unavailable')
    }
  }
  const derived = deriveBrowserRoutePartition({
    orcaProfileId,
    browserProfileId: input.browserProfileId,
    authorityConnectionIdentity: localSshBrowserAuthorityConnectionIdentity(orcaProfileId),
    executionHostIdentity: sshExecutionHostStorageIdentity(input.targetId)
  })
  const bindings = currentBrowserRoutePartitionBindingStore({
    isPartitionRetained: isBrowserRoutePartitionRetainedByAnyOwner
  })
  const persistedFingerprint = bindings.get(derived.partition)
  if (persistedFingerprint === null) {
    const evicted = bindings.set(
      derived.partition,
      derived.bindingFingerprint,
      deriveLocalSshBrowserRoutePartitionStorageScope({ orcaProfileId, targetId: input.targetId })
    )
    if (evicted.length > 0) {
      void releaseEvictedBrowserRoutePartitionStorage(
        evicted,
        isBrowserRoutePartitionRetainedByAnyOwner
      )
    }
  } else if (persistedFingerprint !== derived.bindingFingerprint) {
    throw new Error('browser_route_partition_binding_conflict')
  } else {
    bindings.touch(derived.partition)
  }
  await prepareBrowserRouteSessionPolicy({
    partition: derived.partition,
    browserProfileId: input.browserProfileId,
    proxyEndpoint,
    dependencies: {
      getSession: (partition) => session.fromPartition(partition),
      setupPolicies: ({ partition, browserProfileId }) =>
        browserSessionRegistry.setupRoutePartitionPolicies(partition, browserProfileId),
      clearPolicies: ({ partition }) => {
        browserSessionRegistry.clearRoutePartitionPolicies(partition)
      }
    }
  })
  const prepared: PreparedLocalSshPartition = {
    partition: derived.partition,
    targetId: input.targetId,
    browserProfileId: input.browserProfileId,
    proxyEndpoint
  }
  preparedByPartition.set(derived.partition, prepared)
  partitionBySession.set(session.fromPartition(derived.partition), derived.partition)
  ensureLocalSshWebRtcGuard()
  return prepared
}

export function enforceLocalSshWebRtcPolicyForGuest(guest: WebContents): void {
  if (!localSshBrowserPartitionForSession(guest.session)) {
    return
  }
  enforceBrowserRouteWebRtcPolicy(guest, () => {})
}

let webRtcGuardInstalled = false
function ensureLocalSshWebRtcGuard(): void {
  if (webRtcGuardInstalled) {
    return
  }
  webRtcGuardInstalled = true
  // Cover guests created outside the explicit route-attachment paths.
  app.on('web-contents-created', (_event, contents) => {
    enforceLocalSshWebRtcPolicyForGuest(contents)
  })
}

/** Stops guests and releases route records; the caller clears storage afterward. */
export async function releaseLocalSshBrowserPartitionsForTarget(targetId: string): Promise<void> {
  await closeLocalSshBrowserRouteForTarget(targetId)
  let contentsBySession: Map<Session, WebContents[]> | null = null
  const invalidateContents = (): void => {
    contentsBySession = null
  }
  app.on('web-contents-created', invalidateContents)
  try {
    for (const [identityKey, pending] of preparedByIdentityKey) {
      if (pending.targetId !== targetId) {
        continue
      }
      const prepared = await pending.promise.catch(() => null)
      if (prepared?.targetId === targetId) {
        preparedByIdentityKey.delete(identityKey)
        preparedByPartition.delete(prepared.partition)
        // Close guests before clearing storage so they cannot recreate cookies after bindings are removed.
        const partitionSession = session.fromPartition(prepared.partition)
        if (!contentsBySession) {
          contentsBySession = new Map()
          for (const contents of webContents.getAllWebContents()) {
            if (!contents.isDestroyed()) {
              const peers = contentsBySession.get(contents.session) ?? []
              peers.push(contents)
              contentsBySession.set(contents.session, peers)
            }
          }
        }
        for (const contents of contentsBySession.get(partitionSession) ?? []) {
          if (!contents.isDestroyed()) {
            closeRouteGuest(contents)
          }
        }
        browserSessionRegistry.clearRoutePartitionPolicies(prepared.partition)
      }
    }
  } finally {
    app.removeListener('web-contents-created', invalidateContents)
  }
}

registerBrowserRoutePartitionRetentionProbe((partition) => preparedByPartition.has(partition))
