import { useCallback, useMemo, useState } from 'react'
import { useFocusEffect } from 'expo-router'
import type { AccountsSnapshot } from '../accounts/accounts-snapshot'
import { useSideRailContent, useSideRailStrip } from '../layout/side-rail'
import type { BridgeSideStripFree } from '../mobile-web-shell/bridge/page-geometry/bridge-side-strip-cover'
import { HostRailUsageStack, RailUsageStack } from './RailUsageStack'
import type { RailBotsSource } from './rail-bot-targets'
import { RailUsageSpan } from './RailUsageSpan'
import { pageSideStripRoom } from './side-strip-holder'
import { useRailRingsDuringChats } from './rail-rings-during-chats-preference'

function useScreenFocused(): boolean {
  // Focus rather than mount: the stack keeps a screen mounted under whatever is pushed over it.
  const [focused, setFocused] = useState(false)
  useFocusEffect(
    useCallback(() => {
      setFocused(true)
      return () => setFocused(false)
    }, [])
  )
  return focused
}

/**
 * Fills the Duo side rail with the host's usage rings while the window has a rail: across all of it
 * (`whole`), within one span of it in window points, or not at all (null).
 */
export function useShellUsageRail(
  hostId: string,
  room: 'whole' | BridgeSideStripFree | null
): void {
  const hasStrip = useSideRailStrip() !== null
  const top = room === null || room === 'whole' ? null : room.top
  const bottom = room === null || room === 'whole' ? null : room.bottom
  const shown = room !== null
  const node = useMemo(
    () =>
      shown && hasStrip ? (
        top === null || bottom === null ? (
          <HostRailUsageStack hostId={hostId} />
        ) : (
          <RailUsageSpan span={{ top, bottom }}>
            <HostRailUsageStack hostId={hostId} />
          </RailUsageSpan>
        )
      ) : null,
    [shown, hasStrip, hostId, top, bottom]
  )
  useSideRailContent(node)
}

/** Fills the rail with `snapshot`'s usage rings while this screen is focused; for list screens that leave the rail free. */
export function useFocusedUsageRail(
  snapshot: AccountsSnapshot | null,
  bots: RailBotsSource | null = null
): void {
  const hasStrip = useSideRailStrip() !== null
  const focused = useScreenFocused()
  const node = useMemo(
    () =>
      focused && hasStrip && snapshot !== null ? (
        <RailUsageStack snapshot={snapshot} bots={bots} />
      ) : null,
    [focused, hasStrip, snapshot, bots]
  )
  useSideRailContent(node)
}

type PageReport<T> = { sessionId: string; epoch: number; value: T }

/**
 * A web shell's rings, from what its page last reported: across the whole rail, in the span a chat
 * leaves free (when the user keeps rings during chats), or none. Reports from an older document are dropped.
 */
export function useShellPageUsageRail(args: {
  hostId: string
  sessionId: string | null
  /** False from document-started until the replacement document loads. Session id stays the same. */
  documentOpen: boolean
  ownsHostArea: boolean
  routeGrants: readonly string[]
  shown: boolean
  keyRailClaimed: boolean
}): {
  recordLocation: (href: string) => void
  recordCover: (covered: boolean, free: BridgeSideStripFree | null) => void
} {
  const { sessionId } = args
  const focused = useScreenFocused()
  const [reportEpoch, setReportEpoch] = useState(0)
  const [documentWasOpen, setDocumentWasOpen] = useState(args.documentOpen)
  if (documentWasOpen !== args.documentOpen) {
    setDocumentWasOpen(args.documentOpen)
    // document-started keeps the session id, so the epoch is what retires the previous document's reports.
    if (documentWasOpen && !args.documentOpen) {
      setReportEpoch((epoch) => epoch + 1)
    }
  }
  const [location, setLocation] = useState<PageReport<string> | null>(null)
  const [cover, setCover] = useState<PageReport<{
    covered: boolean
    free: BridgeSideStripFree | null
  }> | null>(null)
  const current = cover?.sessionId === sessionId && cover.epoch === reportEpoch ? cover.value : null
  const room = pageSideStripRoom({
    ownsHostArea: args.ownsHostArea,
    routeGrants: args.routeGrants,
    covered: current?.covered ?? null,
    free: current?.free ?? null,
    location:
      location?.sessionId === sessionId && location.epoch === reportEpoch ? location.value : null,
    keyRailClaimed: args.keyRailClaimed
  })
  const ringsDuringChats = useRailRingsDuringChats()
  useShellUsageRail(
    args.hostId,
    focused && args.shown
      ? room.kind === 'whole'
        ? 'whole'
        : room.kind === 'span' && ringsDuringChats
          ? { top: room.top, bottom: room.bottom }
          : null
      : null
  )
  return {
    recordLocation: (href) => {
      if (sessionId !== null) {
        setLocation({ sessionId, epoch: reportEpoch, value: href })
      }
    },
    recordCover: (covered, free) => {
      if (sessionId !== null) {
        setCover({ sessionId, epoch: reportEpoch, value: { covered, free } })
      }
    }
  }
}
