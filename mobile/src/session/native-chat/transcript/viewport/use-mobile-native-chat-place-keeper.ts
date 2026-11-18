import { useCallback, useRef, type Dispatch, type RefObject, type SetStateAction } from 'react'
import { setBoundedScopeCacheEntry } from '../../../../../../src/shared/native-chat/input/composer/native-chat-scope-cache'
import type { MobileNativeChatRowKeys } from '../projection/mobile-native-chat-row-keys'
import {
  DRAW_AHEAD_SCREENS,
  mobileNativeChatReadingDrift,
  mobileNativeChatReadingPlace,
  mobileNativeChatRowAbove,
  type MobileNativeChatReadingUnit,
  type MobileNativeChatScrollNode
} from './mobile-native-chat-reading-place'
import type { MobileNativeChatScrollRoots } from './mobile-native-chat-scroll-roots'
import { MAX_CACHED_TRANSCRIPTS } from '../persistence/mobile-native-chat-transcript-cache'

// Anchor by key so streaming rows below cannot move the drawn range.
export type MobileNativeChatDrawn = { scope: string; firstKey: string | null; count: number }

type SavedPlace = Omit<MobileNativeChatDrawn, 'scope'> & { place: MobileNativeChatReadingUnit[] }

// One chat view serves every tab, so each chat's place lives here, for the page's lifetime.
const savedPlaces = new Map<string, SavedPlace>()

/** The rows a chat drew when the reader left it away from its tail, so its place can be put back. */
export function savedMobileNativeChatDrawn(scope: string): MobileNativeChatDrawn | null {
  const saved = savedPlaces.get(scope)
  return saved ? { scope, firstKey: saved.firstKey, count: saved.count } : null
}

/** The reader went back to the chat's tail, even while its list is not mounted to see it. */
export function forgetMobileNativeChatPlace(scope: string): void {
  savedPlaces.delete(scope)
}

type Committed = {
  first: number
  n: number
  keys: readonly string[]
  indexOf: ReadonlyMap<string, number>
  layoutKey: string
  rowKeys: Pick<MobileNativeChatRowKeys, 'scope' | 'current' | 'placement'>
}

/** Keeps the reader's place through list changes, and per chat, so returning to a chat puts it back. */
export function useMobileNativeChatPlaceKeeper<S extends MobileNativeChatScrollNode>(args: {
  latest: RefObject<Committed>
  roots?: MobileNativeChatScrollRoots
  isFollowing: () => boolean
  resting: () => boolean
  write: (scroller: S, to: number) => void
  setDrawn: Dispatch<SetStateAction<MobileNativeChatDrawn>>
  onEndDistance: (fromEnd: number, byReader: boolean) => void
  onPlaceRestored: (scope: string) => void
}): { notePlace: (scroller: S) => void; keepPlace: (scroller: S) => void } {
  const { latest, roots, isFollowing, resting, write, setDrawn } = args
  const { onEndDistance, onPlaceRestored } = args
  const place = useRef<MobileNativeChatReadingUnit[] | null>(null)
  // The chat whose place `place` holds; until its saved place is put back, nothing may overwrite it.
  const placedScope = useRef<string | null>(null)
  const placedLayout = useRef(latest.current.layoutKey)

  // Keep one reading anchor so whole-pixel corrections cannot accumulate rounding drift.
  const notePlace = useCallback(
    (s: S) => {
      const { rowKeys, layoutKey, keys, indexOf, first, n } = latest.current
      if (placedScope.current !== rowKeys.scope) {
        return
      }
      place.current = isFollowing() ? null : mobileNativeChatReadingPlace(s, rowKeys)
      placedLayout.current = layoutKey
      if (place.current) {
        // A return draws from just above the place, not every row drawn while reading further up.
        const head = mobileNativeChatRowAbove(s, DRAW_AHEAD_SCREENS * s.clientHeight)
        const from = Math.max(first, indexOf.get(head ?? '') ?? first)
        const saved = { firstKey: keys[from] ?? null, count: n - from, place: place.current }
        setBoundedScopeCacheEntry(savedPlaces, rowKeys.scope, saved, MAX_CACHED_TRANSCRIPTS)
      } else {
        savedPlaces.delete(rowKeys.scope)
      }
    },
    [isFollowing, latest]
  )

  // With nothing saved, or its rows gone, the chat opens following.
  const restorePlace = useCallback(
    (s: S, scope: string) => {
      placedScope.current = scope
      placedLayout.current = latest.current.layoutKey
      const saved = savedPlaces.get(scope)
      const drift =
        saved && mobileNativeChatReadingDrift(saved.place, s, latest.current.rowKeys, roots)
      if (!saved || drift === undefined) {
        place.current = null
        savedPlaces.delete(scope)
        return
      }
      place.current = saved.place
      write(s, s.scrollTop + drift)
      setDrawn((was) =>
        was.scope === scope ? was : { scope, firstKey: saved.firstKey, count: saved.count }
      )
      onEndDistance(Math.max(0, -s.scrollTop), false)
      onPlaceRestored(scope)
    },
    [latest, onEndDistance, onPlaceRestored, roots, setDrawn, write]
  )

  const keepPlace = useCallback(
    (s: S) => {
      const { rowKeys, n, layoutKey } = latest.current
      if (placedScope.current !== rowKeys.scope) {
        // An empty chat shown meanwhile must not leave the last one placed, or a return would overwrite it.
        placedScope.current = null
        if (n > 0) {
          restorePlace(s, rowKeys.scope)
        }
        return
      }
      const held = place.current
      const regrouped = placedLayout.current !== layoutKey
      if (!held || isFollowing() || !(regrouped || resting())) {
        notePlace(s)
        return
      }
      const drift = mobileNativeChatReadingDrift(held, s, rowKeys, roots) ?? 0
      if (Math.abs(drift) >= 0.5) {
        write(s, s.scrollTop + drift)
      }
      // A regroup draws other parts: the line is re-read from them.
      if (regrouped) {
        notePlace(s)
      }
    },
    [isFollowing, latest, notePlace, resting, restorePlace, roots, write]
  )

  return { notePlace, keepPlace }
}
