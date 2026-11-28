import { useEffect, useState } from 'react'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { botRoster } from './bot-group-operations'

/** What each bot is for (by bot id), from its SOUL.md; empty until the host answers. Read again
 *  whenever `client` arrives, so a caller passes null while it can't ask. */
export function useBotPurposes(client: RpcClient | null): ReadonlyMap<string, string> {
  const [purposes, setPurposes] = useState<ReadonlyMap<string, string>>(() => new Map())
  useEffect(() => {
    if (!client) {
      return
    }
    let live = true
    botRoster
      .request(client, { withoutChats: true })
      .then((outcome) => {
        const { bots: roster } = botRoster.interpret(outcome)
        if (live) {
          setPurposes(new Map(roster.flatMap((b) => (b.specialty ? [[b.id, b.specialty]] : []))))
        }
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [client])
  return purposes
}
