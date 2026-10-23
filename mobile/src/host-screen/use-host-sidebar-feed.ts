import { useEffect, useMemo, useRef, useState } from 'react'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../src/shared/sidebar-inputs-switch'
import {
  SIDEBAR_INPUTS_SEMANTICS_VERSION,
  type SidebarInputsChangedEvent
} from '../../../src/shared/sidebar-list/sidebar-inputs-feed-contract'
import type { InstalledSidebarInputs } from '../../../src/shared/sidebar-list/sidebar-inputs-feed-installer'
import {
  readSidebarFeedDomains,
  type SidebarFeedDomains
} from '../../../src/shared/sidebar-list/sidebar-feed-domains'
import type { RpcClient } from '../transport/rpc-client'
import {
  HostSidebarFeedReader,
  type HostSidebarFeedRead,
  type HostSidebarFeedTriggers
} from './host-sidebar-feed-reader'

/** What this page's list rules mean; a host publishing another meaning would build another list. */
const SUPPORTED_SIDEBAR_SEMANTICS_VERSIONS: readonly number[] = [SIDEBAR_INPUTS_SEMANTICS_VERSION]

export type HostSidebarFeed =
  | { kind: 'loading' }
  | { kind: 'ready'; domains: SidebarFeedDomains }
  /** The host lacks the feed or means other things by it: only reopening the page can match it. */
  | { kind: 'reopen' }

export type HostSidebarFeedControls = {
  feed: HostSidebarFeed
  /** Stable for the screen's life, so the refresh lifecycle never restarts for them. */
  triggers: HostSidebarFeedTriggers
}

const NOTHING_READ: HostSidebarFeedRead = { installed: null, unavailable: false }

const MAX_REMEMBERED_HOSTS = 20
/** Each paired host's last installed feed, for this document's next list of it. */
const rememberedFeeds = new Map<string, InstalledSidebarInputs>()

function rememberFeed(hostId: string, installed: InstalledSidebarInputs | null): void {
  rememberedFeeds.delete(hostId)
  if (!installed) {
    return
  }
  rememberedFeeds.set(hostId, installed)
  if (rememberedFeeds.size > MAX_REMEMBERED_HOSTS) {
    const oldest = rememberedFeeds.keys().next().value
    if (oldest !== undefined) {
      rememberedFeeds.delete(oldest)
    }
  }
}

/** The host's last installed feed while a fresh read is out: the desktop's list, if not its newest. */
function rememberedRead(hostId: string | undefined): HostSidebarFeedRead {
  const installed = hostId ? rememberedFeeds.get(hostId) : undefined
  // One this page cannot read would flash "Reopen" for a host whose fresh read may be fine.
  return installed && SUPPORTED_SIDEBAR_SEMANTICS_VERSIONS.includes(installed.semanticsVersion)
    ? { installed, unavailable: false }
    : NOTHING_READ
}

/** Test seam: a fresh document remembers nothing. */
export function forgetRememberedSidebarFeeds(): void {
  rememberedFeeds.clear()
}

export function readHostSidebarFeed({
  installed,
  unavailable
}: HostSidebarFeedRead): HostSidebarFeed {
  if (unavailable) {
    return { kind: 'reopen' }
  }
  if (!installed) {
    return { kind: 'loading' }
  }
  if (!SUPPORTED_SIDEBAR_SEMANTICS_VERSIONS.includes(installed.semanticsVersion)) {
    return { kind: 'reopen' }
  }
  return { kind: 'ready', domains: readSidebarFeedDomains(installed) }
}

/**
 * The connected host's installed sidebar feed; a new client is a new host, read from scratch.
 * Until that read installs, the host's last installed feed stands in for it.
 */
export function useHostSidebarFeed(
  client: RpcClient | null,
  hostId: string | undefined
): HostSidebarFeedControls {
  const readerRef = useRef<HostSidebarFeedReader | null>(null)
  const installListenersRef = useRef(new Set<() => void>())
  const [read, setRead] = useState(() => rememberedRead(hostId))

  useEffect(() => {
    setRead(rememberedRead(hostId))
    if (!client) {
      return
    }
    let lastInstalled: HostSidebarFeedRead['installed'] = null
    const reader = new HostSidebarFeedReader(client, (next) => {
      setRead(next)
      if (hostId) {
        rememberFeed(hostId, next.unavailable ? null : next.installed)
      }
      if (next.installed && next.installed !== lastInstalled) {
        installListenersRef.current.forEach((listener) => listener())
      }
      lastInstalled = next.installed
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
      changed: (notice: Pick<SidebarInputsChangedEvent, 'generation' | 'revision'>) =>
        readerRef.current?.changed(notice),
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

/** Switch point: a page built without the feed reads none. */
export const useSwitchedHostSidebarFeed: (
  client: RpcClient | null,
  hostId: string | undefined
) => HostSidebarFeedControls | null = ORCA_SIDEBAR_INPUTS_IS_MAIN ? useHostSidebarFeed : () => null
