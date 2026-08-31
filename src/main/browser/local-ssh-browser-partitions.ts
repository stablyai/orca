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

const preparedByIdentityKey = new Map<string, Promise<PreparedLocalSshPartition>>()
const preparedByPartition = new Map<string, PreparedLocalSshPartition>()
const partitionBySession = new WeakMap<Session, string>()

/**
 * Connection identity of the app's own SSH provider. Deliberately free of any
 * per-boot value: the same Orca profile reaching the same SSH target must keep
 * reusing one partition, or cookies die on every restart.
 */
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

export function localSshBrowserPartitionTargetId(partition: string): string | null {
  return preparedByPartition.get(partition)?.targetId ?? null
}

export function localSshBrowserPartitionForSession(webSession: Session): string | null {
  return partitionBySession.get(webSession) ?? null
}

/**
 * Derives, binds, and proxies the route partition for (SSH target × browser
 * profile), fail-closed: the partition is only handed to the renderer once
 * `setProxy` is verified, so a page can never paint on an unproxied session.
 */
export async function prepareLocalSshBrowserPartition(input: {
  targetId: string
  browserProfileId: string
  /** Set by the error card's "Try anyway": mounts despite a failed forwarding probe. */
  skipProbe?: boolean
}): Promise<{ partition: string }> {
  // Why: the probe intent is part of the key — otherwise a "Try anyway" success
  // would satisfy every later probed prepare from cache, and clearing the
  // persisted skip in settings could never resurface the classified card
  // without an app restart.
  const identityKey = JSON.stringify([
    input.targetId,
    input.browserProfileId,
    input.skipProbe === true
  ])
  let pending = preparedByIdentityKey.get(identityKey)
  if (!pending) {
    pending = prepareFresh(input)
    preparedByIdentityKey.set(identityKey, pending)
    pending.catch(() => {
      if (preparedByIdentityKey.get(identityKey) === pending) {
        preparedByIdentityKey.delete(identityKey)
      }
    })
  }
  const prepared = await pending
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
    // Why: AllowTcpForwarding no is the one enterprise config that breaks every
    // page while the terminal works; catching it here puts a plain-language
    // explanation on the gate card instead of opaque per-page SOCKS errors.
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
      setupPolicies: ({ partition, browserProfileId }) => {
        browserSessionRegistry.setupRoutePartitionPolicies(partition, browserProfileId)
      },
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

/** Guests, popups, and workers alike: any WebContents born into one of these sessions gets the UDP guard. */
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
  // Why: the route path relies on exact attach call sites for this guard; a
  // session-scoped backstop closes the WebRTC UDP leak for every future guest.
  app.on('web-contents-created', (_event, contents) => {
    enforceLocalSshWebRtcPolicyForGuest(contents)
  })
}

/** Route + partition records for a removed target; storage clearing is the caller's second step. */
export async function releaseLocalSshBrowserPartitionsForTarget(targetId: string): Promise<void> {
  await closeLocalSshBrowserRouteForTarget(targetId)
  for (const [identityKey, pending] of preparedByIdentityKey) {
    const prepared = await pending.catch(() => null)
    if (prepared?.targetId === targetId) {
      preparedByIdentityKey.delete(identityKey)
      preparedByPartition.delete(prepared.partition)
      // Why (review P2-3): a guest still mounted on the partition would write
      // cookies back after the clear, resurrecting an unsweepable directory
      // (its binding is gone, and the orphan scan only walks bindings).
      const partitionSession = session.fromPartition(prepared.partition)
      for (const contents of webContents.getAllWebContents()) {
        if (!contents.isDestroyed() && contents.session === partitionSession) {
          closeRouteGuest(contents)
        }
      }
      browserSessionRegistry.clearRoutePartitionPolicies(prepared.partition)
    }
  }
}

registerBrowserRoutePartitionRetentionProbe((partition) => preparedByPartition.has(partition))

export function resetLocalSshBrowserPartitionsForTests(): void {
  preparedByIdentityKey.clear()
  preparedByPartition.clear()
}
