import { useEffect, useRef, useState } from 'react'
import { MAX_REPO_ICON_IDS_PER_READ } from '../../../src/shared/sidebar-list/repo-icon-data-urls-contract'
import type { RpcClient } from '../transport/rpc-client'
import { readHostMethodReply, sidebarRepoIconsRead } from './host-sidebar-feed-operations'

export const ICON_RETRY_COOLDOWN_MS = 60_000
const MAX_TRACKED_ICON_IDS = 512

const NO_DATA_URLS: ReadonlyMap<string, string | null> = new Map()

// Read icons once per content-hash id and client; null falls back to the phone’s badge, and changed images arrive under new ids.
// Failed reads (dataUrl: null or network failures) allow bounded retries after cooldown.
export function useHostRepoIconDataUrls(
  client: RpcClient | null,
  ids: readonly string[]
): ReadonlyMap<string, string | null> {
  // Keyed by client: another host's icons never show here.
  const [read, setRead] = useState<{
    client: RpcClient | null
    dataUrls: ReadonlyMap<string, string | null>
  }>({ client, dataUrls: NO_DATA_URLS })
  const stateRef = useRef<{
    client: RpcClient | null
    asked: Set<string>
    failedAt: Map<string, number>
  }>({
    client,
    asked: new Set(),
    failedAt: new Map()
  })

  useEffect(() => {
    if (!client) {
      return
    }
    if (stateRef.current.client !== client) {
      stateRef.current = { client, asked: new Set(), failedAt: new Map() }
    }
    const { asked, failedAt } = stateRef.current
    const now = Date.now()
    const wanted = ids.filter((id) => {
      if (!asked.has(id)) {
        return true
      }
      const failTime = failedAt.get(id)
      return failTime !== undefined && now - failTime >= ICON_RETRY_COOLDOWN_MS
    })
    for (let start = 0; start < wanted.length; start += MAX_REPO_ICON_IDS_PER_READ) {
      const batch = wanted.slice(start, start + MAX_REPO_ICON_IDS_PER_READ)
      batch.forEach((id) => {
        asked.add(id)
        failedAt.delete(id)
      })
      void sidebarRepoIconsRead
        .request(client, { ids: batch })
        .then((reply) => readHostMethodReply(reply, sidebarRepoIconsRead.interpret))
        .catch(() => ({ kind: 'failed' as const }))
        .then((reply) => {
          if (reply.kind === 'failed') {
            // Asked again on the next feed install; a host without the method is not.
            batch.forEach((id) => {
              asked.delete(id)
              failedAt.set(id, Date.now())
            })
          }
          if (reply.kind !== 'answered' || stateRef.current.client !== client) {
            return
          }
          const answeredNow = Date.now()
          setRead((current) => {
            const next = new Map(current.client === client ? current.dataUrls : NO_DATA_URLS)
            reply.value.icons.forEach(({ id, dataUrl }) => {
              next.set(id, dataUrl)
              if (dataUrl === null) {
                failedAt.set(id, answeredNow)
              } else {
                failedAt.delete(id)
              }
            })
            if (next.size > MAX_TRACKED_ICON_IDS) {
              const toRemove = next.size - MAX_TRACKED_ICON_IDS
              const keys = next.keys()
              for (let i = 0; i < toRemove; i++) {
                const k = keys.next().value
                if (k) {
                  next.delete(k)
                }
              }
            }
            return { client, dataUrls: next }
          })
        })
    }
  }, [client, ids])

  return read.client === client ? read.dataUrls : NO_DATA_URLS
}
