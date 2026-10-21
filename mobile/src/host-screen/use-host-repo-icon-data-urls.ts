import { useEffect, useRef, useState } from 'react'
import { MAX_REPO_ICON_IDS_PER_READ } from '../../../src/shared/sidebar-list/repo-icon-data-urls-contract'
import type { RpcClient } from '../transport/rpc-client'
import { readHostMethodReply, sidebarRepoIconsRead } from './host-sidebar-feed-operations'

const NO_DATA_URLS: ReadonlyMap<string, string | null> = new Map()

/**
 * The data URL behind each icon id the feed names, read once per id and client. Null: the host has
 * no image within its caps, and the phone draws its own badge. Ids are content hashes, so a changed
 * icon arrives as a new id.
 */
export function useHostRepoIconDataUrls(
  client: RpcClient | null,
  ids: readonly string[]
): ReadonlyMap<string, string | null> {
  // Keyed by client: another host's icons never show here.
  const [read, setRead] = useState<{
    client: RpcClient | null
    dataUrls: ReadonlyMap<string, string | null>
  }>({ client, dataUrls: NO_DATA_URLS })
  const askedRef = useRef<{ client: RpcClient | null; ids: Set<string> }>({
    client,
    ids: new Set()
  })

  useEffect(() => {
    if (!client) {
      return
    }
    if (askedRef.current.client !== client) {
      askedRef.current = { client, ids: new Set() }
    }
    const asked = askedRef.current.ids
    const wanted = ids.filter((id) => !asked.has(id))
    for (let start = 0; start < wanted.length; start += MAX_REPO_ICON_IDS_PER_READ) {
      const batch = wanted.slice(start, start + MAX_REPO_ICON_IDS_PER_READ)
      batch.forEach((id) => asked.add(id))
      void sidebarRepoIconsRead
        .request(client, { ids: batch })
        .then((reply) => readHostMethodReply(reply, sidebarRepoIconsRead.interpret))
        .catch(() => ({ kind: 'failed' as const }))
        .then((reply) => {
          if (reply.kind === 'failed') {
            // Asked again on the next feed install; a host without the method is not.
            batch.forEach((id) => asked.delete(id))
          }
          if (reply.kind !== 'answered' || askedRef.current.client !== client) {
            return
          }
          setRead((current) => {
            const next = new Map(current.client === client ? current.dataUrls : NO_DATA_URLS)
            reply.value.icons.forEach(({ id, dataUrl }) => next.set(id, dataUrl))
            return { client, dataUrls: next }
          })
        })
    }
  }, [client, ids])

  return read.client === client ? read.dataUrls : NO_DATA_URLS
}
