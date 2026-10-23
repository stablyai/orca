import type { BridgeHost } from './bridge-host'
import { gateVerdict } from './mobile-web-shell-gates'
import type {
  MobileWebShellGates,
  MobileWebShellSession
} from './mobile-web-shell-session-contract'
import { isHostRouteOf } from './page-route-policy'
import type { MobileWebShellBridgeArgs } from './use-mobile-web-shell-bridge'
import type { PageHostSnapshot } from './use-page-host-snapshot'

const MAX_PARKED_OUTBOUND_FRAMES = 64

export type RetainedBridgeHostBinding = {
  args: MobileWebShellBridgeArgs
  clientId: string | null
  post: ((json: string) => Promise<void>) | null
  queuedOutboundFrames: string[]
  disposed: boolean
  overflowed: boolean
}

type RetainedBridgeRecord = {
  readonly sessionId: string
  readonly buildId: string
  readonly client: object
  readonly host: BridgeHost
  readonly binding: RetainedBridgeHostBinding
}

type RetainedShellSessionEntry = {
  readonly hostId: string
  readonly routePathname: string
  readonly wide: boolean
  readonly appNamesRoute: boolean
  readonly client: object
  session: MobileWebShellSession
  snapshot: PageHostSnapshot | null
  bridge: RetainedBridgeRecord | null
}

let retainedEntry: RetainedShellSessionEntry | null = null
let latestHostSnapshot: { hostId: string; snapshot: PageHostSnapshot } | null = null
let clearNativeSlot: (() => void) | null = null

export function registerRetainedNativeWebShellClearer(clearer: () => void): void {
  clearNativeSlot = clearer
}

function disposeBridgeOf(entry: RetainedShellSessionEntry | null): void {
  if (entry?.bridge !== null && entry?.bridge !== undefined) {
    entry.bridge.binding.post = null
    entry.bridge.binding.disposed = true
    entry.bridge.binding.queuedOutboundFrames.length = 0
    entry.bridge.host.dispose()
    entry.bridge = null
  }
}

export function evictRetainedShellSession(): void {
  const current = retainedEntry
  retainedEntry = null
  latestHostSnapshot = null
  disposeBridgeOf(current)
  clearNativeSlot?.()
}

export function evictRetainedShellSessionForHost(hostId: string, routePathname?: string): void {
  const entry = retainedEntry
  if (entry?.hostId !== hostId) {
    return
  }
  // A child route retrying itself must not drop the parked host page.
  if (
    routePathname !== undefined &&
    entry.routePathname !== routePathname &&
    isHostRouteOf(entry.routePathname, entry.hostId)
  ) {
    return
  }
  evictRetainedShellSession()
}

export function readRetainedShellSession(args: {
  hostId: string
  routePathname: string
  wide: boolean
  appNamesRoute: boolean
  client: object | null
  gates: MobileWebShellGates
}): MobileWebShellSession | null {
  const entry = retainedEntry
  if (entry === null || args.client === null) {
    return null
  }
  if (
    entry.hostId !== args.hostId ||
    entry.routePathname !== args.routePathname ||
    entry.wide !== args.wide ||
    entry.appNamesRoute !== args.appNamesRoute ||
    entry.client !== args.client
  ) {
    return null
  }
  if (
    entry.session.state.kind !== 'ready' ||
    !entry.session.pagePainted ||
    gateVerdict(args.gates).kind !== 'open'
  ) {
    evictRetainedShellSession()
    return null
  }
  return {
    ...entry.session,
    gates: args.gates
  }
}

export function recordSessionInRetainedStore(
  hostId: string,
  client: object | null,
  session: MobileWebShellSession
): void {
  const { routePathname, wide, appNamesRoute } = session
  recordRetainedShellSession({ hostId, routePathname, wide, appNamesRoute, client, session })
}

export function recordRetainedShellSession(args: {
  hostId: string
  routePathname: string
  wide: boolean
  appNamesRoute: boolean
  client: object | null
  session: MobileWebShellSession
}): void {
  if (args.client === null) {
    return
  }
  if (args.session.state.kind !== 'ready' || !args.session.pagePainted) {
    if (
      retainedEntry?.hostId === args.hostId &&
      retainedEntry.client === args.client &&
      retainedEntry.routePathname === args.routePathname
    ) {
      evictRetainedShellSession()
    }
    return
  }
  const existing = retainedEntry
  if (
    existing !== null &&
    existing.hostId === args.hostId &&
    existing.routePathname === args.routePathname &&
    existing.wide === args.wide &&
    existing.appNamesRoute === args.appNamesRoute &&
    existing.client === args.client &&
    existing.session.state.kind === 'ready' &&
    existing.session.state.sessionId === args.session.state.sessionId
  ) {
    existing.session = args.session
    return
  }
  // A child route paints its own document and must leave the parked host page in the slot,
  // unless its commit replaced the host's generation directory on disk.
  if (
    existing !== null &&
    existing.hostId === args.hostId &&
    isHostRouteOf(existing.routePathname, existing.hostId) &&
    !isHostRouteOf(args.routePathname, args.hostId)
  ) {
    if (
      existing.session.state.kind === 'ready' &&
      existing.session.state.buildId !== args.session.state.buildId
    ) {
      evictRetainedShellSession()
    }
    return
  }
  disposeBridgeOf(existing)
  retainedEntry = {
    hostId: args.hostId,
    routePathname: args.routePathname,
    wide: args.wide,
    appNamesRoute: args.appNamesRoute,
    client: args.client,
    session: args.session,
    snapshot:
      existing?.hostId === args.hostId
        ? existing.snapshot
        : latestHostSnapshot?.hostId === args.hostId
          ? latestHostSnapshot.snapshot
          : null,
    bridge: null
  }
}

export function readRetainedPageHostSnapshot(hostId: string): PageHostSnapshot | null {
  if (
    retainedEntry !== null &&
    retainedEntry.hostId === hostId &&
    retainedEntry.session.state.kind === 'ready' &&
    retainedEntry.session.pagePainted &&
    retainedEntry.snapshot !== null
  ) {
    return retainedEntry.snapshot
  }
  return null
}

export function recordRetainedPageHostSnapshot(
  hostId: string,
  snapshot: PageHostSnapshot | null
): void {
  if (snapshot === null) {
    if (latestHostSnapshot?.hostId === hostId) {
      latestHostSnapshot = null
    }
  } else {
    latestHostSnapshot = { hostId, snapshot }
  }
  if (retainedEntry !== null && retainedEntry.hostId === hostId) {
    retainedEntry.snapshot = snapshot
  }
}

export function takeRetainedBridgeHost(args: {
  hostId: string
  sessionId: string
  buildId: string
  client: object
  sessionEstablished?: boolean
}): { host: BridgeHost; binding: RetainedBridgeHostBinding } | null {
  const entry = retainedEntry
  if (entry === null || entry.bridge === null) {
    return null
  }
  // A client or host that cannot resume this bridge must not leave it parked: its subscriptions
  // stay on the retired client until some later dispatch happens to dispose it.
  if (entry.hostId !== args.hostId || entry.client !== args.client) {
    disposeBridgeOf(entry)
    return null
  }
  if (
    args.sessionEstablished === false ||
    entry.bridge.sessionId !== args.sessionId ||
    entry.bridge.buildId !== args.buildId ||
    entry.bridge.client !== args.client ||
    entry.bridge.binding.overflowed
  ) {
    disposeBridgeOf(entry)
    return null
  }
  const bridge = entry.bridge
  entry.bridge = null
  return { host: bridge.host, binding: bridge.binding }
}

export function parkRetainedBridgeHost(args: {
  hostId: string
  sessionId: string
  buildId: string
  client: object
  host: BridgeHost
  binding: RetainedBridgeHostBinding
}): boolean {
  const entry = retainedEntry
  if (
    entry === null ||
    entry.hostId !== args.hostId ||
    entry.client !== args.client ||
    entry.session.state.kind !== 'ready' ||
    !entry.session.pagePainted ||
    entry.session.state.sessionId !== args.sessionId ||
    entry.session.state.buildId !== args.buildId
  ) {
    return false
  }
  disposeBridgeOf(entry)
  args.binding.post = null
  args.binding.disposed = false
  args.binding.overflowed = false
  entry.bridge = {
    sessionId: args.sessionId,
    buildId: args.buildId,
    client: args.client,
    host: args.host,
    binding: args.binding
  }
  return true
}

export function postOrQueueRetainedBridgeFrame(
  binding: RetainedBridgeHostBinding,
  json: string,
  onGone: () => Error
): Promise<void> {
  if (binding.post !== null) {
    return binding.post(json)
  }
  if (!binding.disposed && !binding.overflowed) {
    if (binding.queuedOutboundFrames.length < MAX_PARKED_OUTBOUND_FRAMES) {
      binding.queuedOutboundFrames.push(json)
      return Promise.resolve()
    }
    binding.overflowed = true
    binding.queuedOutboundFrames.length = 0
  }
  return Promise.reject(onGone())
}

export function flushRetainedBridgeFrames(
  binding: RetainedBridgeHostBinding,
  post: (json: string) => Promise<void>
): void {
  binding.post = post
  if (binding.queuedOutboundFrames.length === 0) {
    return
  }
  const pending = binding.queuedOutboundFrames.splice(0)
  for (const frame of pending) {
    void post(frame).catch(() => undefined)
  }
}
