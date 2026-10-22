import {
  SidebarFeedReader,
  type SidebarFeedNotice,
  type SidebarFeedReaderRead
} from '../../../src/shared/sidebar-feed-client/sidebar-feed-reader'
import type { UnvalidatedRpcRequestPort } from '../transport/unvalidated-rpc-request-port'
import { hostSidebarFeedTransport } from './host-sidebar-feed-operations'

/** What the worktree refresh drives the feed with. */
export type HostSidebarFeedTriggers = {
  refresh: () => void
  changed: (notice: SidebarFeedNotice) => void
  /** Each new install; returns the unsubscribe. */
  onInstalled: (listener: () => void) => () => void
}

// A read that fails with the connection up gets no ready to repeat it; back off so a failing host is not hammered.
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000]

/** The page's reader of one host connection's feed. */
export function createHostSidebarFeedReader(
  client: UnvalidatedRpcRequestPort,
  onRead: (read: SidebarFeedReaderRead) => void
): SidebarFeedReader {
  return new SidebarFeedReader(
    hostSidebarFeedTransport(client),
    { retryDelayMs: (failures) => RETRY_DELAYS_MS[failures] ?? null },
    onRead
  )
}
