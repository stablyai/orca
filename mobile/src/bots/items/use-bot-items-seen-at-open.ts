import { useEffect, useRef, useState } from 'react'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { markBotItemsOpened } from './bot-item-operations'

/** The seen mark as the panel opened: rows changed since keep their dot while it stays open; opening
 *  moves the one mark (shared with the desktop) once the first read says where it was. */
export function useBotItemsSeenAtOpen(
  visible: boolean,
  read: { seenEventId: string } | null,
  client: RpcClient | null,
  botId: string
): string | null {
  const [seenAtOpen, setSeenAtOpen] = useState<string | null>(null)
  const marked = useRef(false)
  if (!visible && seenAtOpen !== null) {
    setSeenAtOpen(null)
  }
  if (visible && seenAtOpen === null && read) {
    setSeenAtOpen(read.seenEventId)
  }
  useEffect(() => {
    if (!visible) {
      marked.current = false
      return
    }
    if (seenAtOpen !== null && !marked.current && client) {
      marked.current = true
      markBotItemsOpened(client, botId)
    }
  }, [visible, seenAtOpen, client, botId])
  return seenAtOpen
}
