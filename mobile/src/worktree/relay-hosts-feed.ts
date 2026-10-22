// The paired desktop's servers (`mobileRelay.hosts.list`), one feed per desktop client: the host
// list's poll and every open server workspace share one read, so two readers never double the
// desktop's load. The host list reads without subscribing, so its badge may trail a workspace by a tick.

import { useCallback, useSyncExternalStore } from 'react'
import { AppState } from 'react-native'
import type { MobileRelayHost } from '../../../src/shared/mobile-relay-hosts-contract'
import type { RpcClient } from '../transport/rpc-client'
import { relayHostsListRead } from './server-workspace-operations'

// The host list's own poll cadence, counted from when the last read finished.
const RELAY_HOSTS_POLL_MS = 3000

export type RelayHostsFeed = {
  subscribe: (listener: () => void) => () => void
  /** The last answer on this connection; null before one lands. */
  getSnapshot: () => readonly MobileRelayHost[] | null
  /** Reads now, or joins the read in flight; null when the desktop did not answer. */
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
  const listeners = new Set<() => void>()

  const publish = (next: readonly MobileRelayHost[] | null): void => {
    // Why: an unchanged poll keeps its identity, so readers do not re-render every tick.
    if (JSON.stringify(next) === JSON.stringify(snapshot)) {
      return
    }
    snapshot = next
    for (const listener of listeners) {
      listener()
    }
  }
  const stopTimer = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }
  // Timed reads run only while someone subscribes and the desktop is connected.
  const schedule = (): void => {
    stopTimer()
    if (listeners.size === 0 || client.getState() !== 'connected') {
      return
    }
    const delay = lastReadAt + RELAY_HOSTS_POLL_MS - Date.now()
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
      // A reply from before a drop is not this connection's answer.
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
    const readGeneration = generation
    inFlight = fetchHosts(readGeneration).finally(() => {
      if (readGeneration === generation) {
        inFlight = null
        // Why: scheduling from the finish, so a read slower than the poll still gets a next one.
        lastReadAt = Date.now()
        schedule()
      }
    })
    return inFlight
  }

  client.onStateChange((state) => {
    if (state !== 'connected') {
      generation += 1
      inFlight = null
      lastReadAt = Number.NEGATIVE_INFINITY
      publish(null)
    }
    schedule()
  })
  return {
    subscribe: (listener) => {
      listeners.add(listener)
      schedule()
      return () => {
        listeners.delete(listener)
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
  let feed = feeds.get(client)
  if (!feed) {
    feed = createFeed(client)
    feeds.set(client, feed)
  }
  return feed
}

const noSubscription = (): (() => void) => () => {}

/** The desktop's servers from the shared feed while `client` is set; null before it answers. */
export function useRelayHosts(client: RpcClient | null): readonly MobileRelayHost[] | null {
  const feed = client ? relayHostsFeed(client) : null
  const subscribe = useCallback(
    (listener: () => void) => (feed ? feed.subscribe(listener) : noSubscription()),
    [feed]
  )
  const readHosts = () => feed?.getSnapshot() ?? null
  return useSyncExternalStore(subscribe, readHosts, readHosts)
}
