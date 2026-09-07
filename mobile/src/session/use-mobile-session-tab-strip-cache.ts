import { useEffect, useState } from 'react'
import {
  getSessionTabStripCacheKey,
  loadCachedSessionTabStrip,
  readCachedSessionTabStrip,
  saveCachedSessionTabStrip
} from '../cache/session-tab-strip-cache'
import {
  toMobileSessionTabStripPreview,
  type MobileSessionTabStripPreview
} from './mobile-session-tab-strip-entries'
import type { MobileSessionBulkCloseModel } from './use-mobile-session-bulk-close'

/**
 * Keeps the last drawn tab strip for this workspace on the device, so a reconnect has something
 * to render before the first snapshot lands. See mobile-session-reconnect-view-state.
 */
export function useMobileSessionTabStripCache(scope: MobileSessionBulkCloseModel) {
  const { hostId, worktreeId, connState, terminalsLoaded } = scope
  const { visibleTabs, activeSessionTabId, activeHandle } = scope
  const cacheKey = getSessionTabStripCacheKey(hostId, worktreeId)
  // Why: state settles a commit behind the key it was read for, so carry the key with it —
  // otherwise the first render after a workspace switch draws the previous workspace's strip.
  const [loaded, setLoaded] = useState<{
    key: string | null
    preview: MobileSessionTabStripPreview | null
  }>(() => ({ key: cacheKey, preview: readCachedSessionTabStrip(cacheKey) }))

  useEffect(() => {
    // Synchronous first, so an in-session revisit never blinks through the uncached branch.
    setLoaded({ key: cacheKey, preview: readCachedSessionTabStrip(cacheKey) })
    let disposed = false
    void loadCachedSessionTabStrip(cacheKey).then((preview) => {
      if (!disposed) {
        setLoaded({ key: cacheKey, preview })
      }
    })
    return () => {
      disposed = true
    }
  }, [cacheKey])
  const cachedTabStrip = loaded.key === cacheKey ? loaded.preview : null

  // Only a host-confirmed strip is worth persisting, and an emptied workspace has to be written
  // too — skipping it would leave yesterday's tabs to be drawn over a session that no longer has
  // them. The one reading we do not trust is a live terminal with no tab record behind it, which
  // is the same case the empty state refuses to claim (use-mobile-session-presentation).
  // react-doctor-disable-next-line react-doctor/effect-needs-cleanup
  useEffect(() => {
    if (connState !== 'connected' || !terminalsLoaded) {
      return
    }
    if (visibleTabs.length === 0 && activeHandle !== null) {
      return
    }
    saveCachedSessionTabStrip(
      cacheKey,
      toMobileSessionTabStripPreview(visibleTabs, activeSessionTabId)
    )
  }, [activeHandle, activeSessionTabId, cacheKey, connState, terminalsLoaded, visibleTabs])

  return { cachedTabStrip }
}

export type MobileSessionTabStripCacheModel = MobileSessionBulkCloseModel &
  ReturnType<typeof useMobileSessionTabStripCache>
