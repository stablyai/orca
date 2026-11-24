// What a shared agent's page and its chats read: the agent as this phone reaches it, the client to
// its host, and its row as that host lists it, read again each time the phone's link comes up.
import { useEffect, useMemo, useState } from 'react'
import type { SharedBotHostView } from '../../../../src/shared/bots/shared-bot-hosts'
import { useHostClient } from '../../transport/connection/host-client-hooks'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { PhoneBot } from '../host-bots-operations'
import { readSharedAgentBot, sharedAgentClient } from './shared-agent-bot-read'
import { useSharedAgentViews } from './use-shared-agent-views'
import { readHostStatusReply } from '../../query/host-status-query'
import { readProbedHostCapabilities } from '../../transport/connection/host-status-probe-operations'

export type SharedAgentPage =
  | { kind: 'loading' }
  /** No longer shared with this account: the last view of it, if the page had one. */
  | { kind: 'removed'; last: SharedBotHostView | null; bot: PhoneBot | undefined }
  | {
      kind: 'agent'
      view: SharedBotHostView
      client: RpcClient | null
      bot: PhoneBot | undefined
      /** The host's capabilities, from its last read; null before one. */
      capabilities: readonly string[] | null
      live: boolean
      /** Counts the link coming up, so the agent's reads read again. */
      reads: number
    }

export function useSharedAgentPage(hostId: string, environmentId: string): SharedAgentPage {
  const views = useSharedAgentViews(hostId)
  const view = views?.find((entry) => entry.environmentId === environmentId)
  const [last, setLast] = useState<SharedBotHostView | null>(null)
  useEffect(() => {
    if (view) {
      setLast(view)
    }
  }, [view])
  const { client: paired } = useHostClient(hostId)
  const client = useMemo(
    () => (paired ? sharedAgentClient(paired, environmentId) : null),
    [paired, environmentId]
  )
  const live = view?.link === 'live'
  const [reads, setReads] = useState(0)
  const [bot, setBot] = useState<PhoneBot | undefined>(undefined)
  const [capabilities, setCapabilities] = useState<readonly string[] | null>(null)
  const known = view !== undefined
  // On open (while away the phone answers from the host's last answers), and each time the link comes up.
  useEffect(() => {
    if (!paired || !view) {
      return
    }
    setReads((count) => count + 1)
    let current = true
    void readSharedAgentBot(paired, hostId, view).then((read) => current && read && setBot(read))
    void readHostStatusReply(sharedAgentClient(paired, environmentId))
      .then((reply) => readProbedHostCapabilities(reply))
      .then((read) => current && read && setCapabilities(read))
      .catch(() => {})
    return () => {
      current = false
    }
  }, [known, live, paired, hostId])
  if (views === null) {
    return { kind: 'loading' }
  }
  // Gone from the computer's shares: its owner stopped sharing it (or this account left).
  if (!view) {
    return { kind: 'removed', last, bot }
  }
  return { kind: 'agent', view, client, bot, capabilities, live, reads }
}
