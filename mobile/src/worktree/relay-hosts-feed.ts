// Share reads per desktop across its host list and open server workspaces to avoid multiplying poll load.

import { useCallback, useSyncExternalStore } from 'react'
import { AppState } from 'react-native'
import { MOBILE_RELAY_HOSTS_CHANGED_EVENT_RUNTIME_CAPABILITY } from '../../../src/shared/mobile-desktop-relay-contract'
import { readViewBase } from '../query/host-read-client'
import type { MobileRelayHost } from '../../../src/shared/remote-runtime/relay/mobile-relay-hosts-contract'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import {
  subscribeSharedClientEvents,
  type SharedClientEvent
} from '../transport/connection/shared-client-events'
import { relayHostsListRead } from './server-workspace-operations'

// Count polling cadence from the last completed read.
const RELAY_HOSTS_POLL_MS = 3000
// With relayHostsChanged heard on a live stream, the poll only backs up a lost notice.
const RELAY_HOSTS_BACKSTOP_POLL_MS = 60_000

export type RelayHostsFeed = {
  /** `pushed`: the desktop publishes relayHostsChanged, so the feed may wait for it instead of polling. */
  subscribe: (listener: () => void, pushed: boolean) => () => void
  getSnapshot: () => readonly MobileRelayHost[] | null
  /** Answers from the snapshot while the desktop's notices keep it current; reads otherwise. */
  read: () => Promise<readonly MobileRelayHost[] | null>
}

const feeds = new WeakMap<RpcClient, RelayHostsFeed>()

function createFeed(client: RpcClient): RelayHostsFeed {
  let snapshot: readonly MobileRelayHost[] | null = null
  let inFlight: Promise<readonly MobileRelayHost[] | null> | null = null
  let lastReadAt = Number.NEGATIVE_INFINITY
  // Bumped on every drop, so a read from an earlier connection never lands.
  let generation = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  // Each listener with whether its desktop publishes relayHostsChanged.
  const listeners = new Map<() => void, boolean>()
  let stopEvents: (() => void) | null = null
  let streamLive = false
  // The last read failed, or a notice came during it, so its answer may already be old.
  let lastReadDoubtful = false
  let changedDuringRead = false

  // The desktop will tell this feed when its snapshot goes out of date.
  const current = (): boolean =>
    stopEvents !== null &&
    streamLive &&
    snapshot !== null &&
    !lastReadDoubtful &&
    Number.isFinite(lastReadAt)

  const publish = (next: readonly MobileRelayHost[] | null): void => {
    // Why: an unchanged poll keeps its identity, so readers do not re-render every tick.
    if (JSON.stringify(next) === JSON.stringify(snapshot)) {
      return
    }
    snapshot = next
    for (const listener of listeners.keys()) {
      listener()
    }
  }
  const stopTimer = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }
  const schedule = (): void => {
    stopTimer()
    if (listeners.size === 0 || client.getState() !== 'connected') {
      return
    }
    const pollMs = current() ? RELAY_HOSTS_BACKSTOP_POLL_MS : RELAY_HOSTS_POLL_MS
    const delay = lastReadAt + pollMs - Date.now()
    if (delay <= 0) {
      tick()
      return
    }
    timer = setTimeout(tick, delay)
  }
  const tick = (): void => {
    timer = null
    if (AppState.currentState === 'active') {
      void read()
      return
    }
    timer = setTimeout(tick, RELAY_HOSTS_POLL_MS)
  }
  const fetchHosts = async (readGeneration: number): Promise<readonly MobileRelayHost[] | null> => {
    try {
      const listed = relayHostsListRead.interpret(await relayHostsListRead.request(client))
      if (!listed.accepted || readGeneration !== generation) {
        return null
      }
      publish(listed.value)
      return listed.value
    } catch {
      return null
    }
  }
  const read = (): Promise<readonly MobileRelayHost[] | null> => {
    if (inFlight) {
      return inFlight
    }
    if (current()) {
      return Promise.resolve(snapshot)
    }
    const readGeneration = generation
    changedDuringRead = false
    inFlight = fetchHosts(readGeneration).then((hosts) => {
      if (readGeneration === generation) {
        inFlight = null
        lastReadDoubtful = hosts === null || changedDuringRead
        // Schedule after completion so reads slower than the interval still get a next poll.
        lastReadAt = changedDuringRead ? Number.NEGATIVE_INFINITY : Date.now()
        schedule()
      }
      return hosts
    })
    return inFlight
  }

  // The list may have changed since the last read: read again as soon as the page is active.
  const changed = (): void => {
    if (inFlight) {
      changedDuringRead = true
      return
    }
    lastReadAt = Number.NEGATIVE_INFINITY
    schedule()
  }
  const onEvent = (event: SharedClientEvent): void => {
    if (event.type === 'ready') {
      streamLive = true
      // Every ready: a change between the last read and this stream going live sent no notice.
      changed()
    } else if (event.type === 'end' || event.type === 'error') {
      // The shared stream opens again by itself; until its ready, poll as an older desktop.
      streamLive = false
      schedule()
    } else if (event.type === 'relayHostsChanged') {
      changed()
    }
  }
  // Only while a listener's desktop publishes the notice: older desktops keep the plain poll.
  const syncEvents = (): void => {
    const wanted = [...listeners.values()].includes(true)
    if (wanted && !stopEvents) {
      stopEvents = subscribeSharedClientEvents(client, onEvent)
    } else if (!wanted && stopEvents) {
      stopEvents()
      stopEvents = null
      streamLive = false
    }
  }

  client.onStateChange((state) => {
    if (state !== 'connected') {
      generation += 1
      inFlight = null
      lastReadAt = Number.NEGATIVE_INFINITY
      streamLive = false
      publish(null)
    }
    schedule()
  })
  return {
    subscribe: (listener, pushedByDesktop) => {
      listeners.set(listener, pushedByDesktop)
      syncEvents()
      schedule()
      return () => {
        listeners.delete(listener)
        syncEvents()
        if (listeners.size === 0) {
          stopTimer()
        }
      }
    },
    getSnapshot: () => snapshot,
    read
  }
}

export function relayHostsFeed(client: RpcClient): RelayHostsFeed {
  // A query's fail-fast view shares the feed its connection's screens already hold.
  const owner = readViewBase(client)
  let feed = feeds.get(owner)
  if (!feed) {
    feed = createFeed(owner)
    feeds.set(owner, feed)
  }
  return feed
}

const noSubscription = (): (() => void) => () => {}

export function useRelayHosts(
  client: RpcClient | null,
  hostCapabilities: readonly string[]
): readonly MobileRelayHost[] | null {
  const feed = client ? relayHostsFeed(client) : null
  const pushed = hostCapabilities.includes(MOBILE_RELAY_HOSTS_CHANGED_EVENT_RUNTIME_CAPABILITY)
  const subscribe = useCallback(
    (listener: () => void) => (feed ? feed.subscribe(listener, pushed) : noSubscription()),
    [feed, pushed]
  )
  const readHosts = () => feed?.getSnapshot() ?? null
  return useSyncExternalStore(subscribe, readHosts, readHosts)
}
