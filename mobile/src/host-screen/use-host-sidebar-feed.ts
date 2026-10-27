import { useEffect, useMemo, useRef, useState } from 'react'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../src/shared/sidebar-inputs-switch'
import type { SidebarFeedDomains } from '../../../src/shared/sidebar-list/sidebar-feed-domains'
import type {
  SidebarFeedNotice,
  SidebarFeedReader
} from '../../../src/shared/sidebar-feed-client/sidebar-feed-reader'
import {
  isReadableSidebarFeed,
  type SidebarFeedSnapshot
} from '../../../src/shared/sidebar-feed-client/sidebar-feed-snapshot'
import { RememberedSidebarFeeds } from '../../../src/shared/sidebar-feed-client/remembered-sidebar-feeds'
import type { RpcClient } from '../transport/rpc-client'
import {
  createHostSidebarFeedReader,
  type HostSidebarFeedTriggers
} from './host-sidebar-feed-connection'

export type HostSidebarFeedRead = {
  snapshot: SidebarFeedSnapshot | null
  /** The host has no feed (method_not_found, or forbidden by an older mobile allowlist). */
  unavailable: boolean
}

export type HostSidebarFeed =
  | { kind: 'loading' }
  | { kind: 'ready'; domains: SidebarFeedDomains }
  | { kind: 'reopen' }

export type HostSidebarFeedControls = {
  feed: HostSidebarFeed
  triggers: HostSidebarFeedTriggers
}

const NOTHING_READ: HostSidebarFeedRead = { snapshot: null, unavailable: false }

const rememberedFeeds = new RememberedSidebarFeeds(20)

function rememberedRead(hostId: string | undefined): HostSidebarFeedRead {
  const snapshot = hostId ? rememberedFeeds.recall(hostId) : null
  // One this page cannot read would flash "Reopen" for a host whose fresh read may be fine.
  return snapshot && isReadableSidebarFeed(snapshot)
    ? { snapshot, unavailable: false }
    : NOTHING_READ
}

export function forgetRememberedSidebarFeeds(): void {
  rememberedFeeds.forgetAll()
}

export function readHostSidebarFeed({
  snapshot,
  unavailable
}: HostSidebarFeedRead): HostSidebarFeed {
  if (unavailable) {
    return { kind: 'reopen' }
  }
  if (!snapshot) {
    return { kind: 'loading' }
  }
  return isReadableSidebarFeed(snapshot)
    ? { kind: 'ready', domains: snapshot.domains }
    : { kind: 'reopen' }
}

// A new client reads from scratch; keep that host’s last installed feed visible until the new read installs.
export function useHostSidebarFeed(
  client: RpcClient | null,
  hostId: string | undefined
): HostSidebarFeedControls {
  const readerRef = useRef<SidebarFeedReader | null>(null)
  const installListenersRef = useRef(new Set<() => void>())
  const [read, setRead] = useState(() => rememberedRead(hostId))

  useEffect(() => {
    setRead(rememberedRead(hostId))
    if (!client) {
      return
    }
    let last: HostSidebarFeedRead = NOTHING_READ
    const reader = createHostSidebarFeedReader(client, ({ snapshot, unavailable }) => {
      // A read that settles on what is installed changes nothing this list draws.
      if (snapshot === last.snapshot && unavailable === last.unavailable) {
        return
      }
      const installed = snapshot !== null && snapshot !== last.snapshot
      last = { snapshot, unavailable }
      setRead(last)
      if (hostId) {
        rememberedFeeds.remember(hostId, unavailable ? null : snapshot)
      }
      if (installed) {
        installListenersRef.current.forEach((listener) => listener())
      }
    })
    readerRef.current = reader
    return () => {
      reader.dispose()
      if (readerRef.current === reader) {
        readerRef.current = null
      }
    }
  }, [client, hostId])

  const triggers = useMemo(
    (): HostSidebarFeedTriggers => ({
      refresh: () => readerRef.current?.refresh(),
      changed: (notice: SidebarFeedNotice) => readerRef.current?.changed(notice),
      onInstalled: (listener: () => void) => {
        installListenersRef.current.add(listener)
        return () => installListenersRef.current.delete(listener)
      }
    }),
    []
  )
  const feed = useMemo(() => readHostSidebarFeed(read), [read])
  return { feed, triggers }
}

export const useSwitchedHostSidebarFeed: (
  client: RpcClient | null,
  hostId: string | undefined
) => HostSidebarFeedControls | null = ORCA_SIDEBAR_INPUTS_IS_MAIN ? useHostSidebarFeed : () => null
