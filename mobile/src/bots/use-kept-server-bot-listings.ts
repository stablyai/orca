import { useEffect, useMemo, useRef } from 'react'
import type { ExecutionHostId } from '../../../src/shared/execution-host/execution-host'
import type { MobileRelayHost } from '../../../src/shared/remote-runtime/relay/mobile-relay-hosts-contract'
import type { HostBotListing } from './host-bot-listing'
import { keepServerBotListing, readKeptServerBotListings } from './kept-server-bot-listings'
import { mergeKeptServerBotListing } from './host-bot-listing-merge'

/** Starts each listed server from its kept listing, keeps each newer read, and forgets a server once the desktop stops listing it. */
export function useKeptServerBotListings(args: {
  pairedHostId: string | undefined
  serverHosts: readonly MobileRelayHost[]
  listings: readonly HostBotListing[]
  setListings: (update: (previous: readonly HostBotListing[]) => readonly HostBotListing[]) => void
}): void {
  const { pairedHostId, serverHosts, listings, setListings } = args
  // The ids alone: the hosts array changes on every health update.
  const serverIdsKey = serverHosts.map((host) => host.hostId).join('\n')
  // serverIdsKey stands for these ids.
  const serverIds = useMemo(() => serverHosts.map((host) => host.hostId), [serverIdsKey])
  // A server is seeded once its read has landed; one read out at a time per server.
  const seeded = useRef(new Set<string>())
  const reading = useRef(new Set<string>())
  // Only a listing that changed is handed on, its write waiting for the burst to settle; a kept one is already stored.
  const handed = useRef(new Map<string, HostBotListing>())
  // A read that lands after the screen moved to another paired host, or went away, is dropped.
  const shownFor = useRef<string | undefined>(undefined)
  useEffect(() => {
    shownFor.current = pairedHostId
    return () => {
      shownFor.current = undefined
    }
  }, [pairedHostId])
  useEffect(() => {
    if (!pairedHostId) {
      return
    }
    const slot = (hostId: ExecutionHostId): string => `${pairedHostId}\n${hostId}`
    // A change to the server list mid-read never cancels it: each server's read lands once.
    const unread = serverIds.filter(
      (hostId) => !seeded.current.has(slot(hostId)) && !reading.current.has(slot(hostId))
    )
    if (unread.length === 0) {
      return
    }
    unread.forEach((hostId) => reading.current.add(slot(hostId)))
    void readKeptServerBotListings(pairedHostId, unread).then((kept) => {
      unread.forEach((hostId) => {
        reading.current.delete(slot(hostId))
        seeded.current.add(slot(hostId))
      })
      // A read that landed first is newer than anything kept.
      if (shownFor.current === pairedHostId && kept.length > 0) {
        kept.forEach((entry) => handed.current.set(slot(entry.hostId), entry))
        setListings((previous) => {
          const hydrated = kept.map((entry) =>
            mergeKeptServerBotListing(
              previous.find((listing) => listing.hostId === entry.hostId),
              entry
            )
          )
          return hydrated.every((entry) => previous.includes(entry))
            ? previous
            : [
                ...previous.filter(
                  (listing) => !kept.some((entry) => entry.hostId === listing.hostId)
                ),
                ...hydrated
              ]
        })
      }
    })
  }, [pairedHostId, serverIds, setListings])

  useEffect(() => {
    if (!pairedHostId) {
      return
    }
    const listed = new Set<ExecutionHostId>(serverIds)
    for (const listing of listings) {
      const key = `${pairedHostId}\n${listing.hostId}`
      if (
        listing.kind === 'listed' &&
        listed.has(listing.hostId) &&
        handed.current.get(key) !== listing
      ) {
        handed.current.set(key, listing)
        keepServerBotListing(pairedHostId, listing.hostId, listing)
      }
    }
  }, [pairedHostId, serverIds, listings])

  // A server the desktop no longer lists is unpaired: its kept listing goes. An empty list says nothing.
  const lastServerIds = useRef<readonly MobileRelayHost['hostId'][]>([])
  useEffect(() => {
    if (!pairedHostId || serverIds.length === 0) {
      return
    }
    for (const hostId of lastServerIds.current) {
      if (!serverIds.includes(hostId)) {
        handed.current.delete(`${pairedHostId}\n${hostId}`)
        keepServerBotListing(pairedHostId, hostId, null)
      }
    }
    lastServerIds.current = serverIds
  }, [pairedHostId, serverIds])
}
