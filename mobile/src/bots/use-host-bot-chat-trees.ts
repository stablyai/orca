import { useEffect, useMemo, useRef, useState } from 'react'
import { AppState } from 'react-native'
import {
  BOT_WORK_KINDS,
  botChangeConcerns,
  readBotChangeScope
} from '../../../src/shared/bots/bot-change-scope'
import {
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../src/shared/execution-host/execution-host'
import { subscribeSharedClientEvents } from '../transport/connection/shared-client-events'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { rpcClientForExecutionHost } from '../worktree/execution-hosts/execution-host-scoped-rpc-client'
import type { HostBotListing } from './host-bot-listing'
import { hostBotFoldKey } from './host-bot-fold-key'
import { useBotChatFolds } from './bot-chat-fold-store'
import { useBotChatSteps } from './bot-chat-steps-store'
import {
  hostBotTreeKey,
  startBotChatTreeReads,
  type HostBotChatTrees,
  type WantedBotChatTree
} from './bot-chat-tree-reads'
import type { HostBotSectionInputs } from './host-bot-entries'

const NO_TREES: HostBotChatTrees = new Map()

/** What the Bots list draws chats from: each unfolded bot's chats, and this phone's folds and steps. */
export function useHostBotChatListInputs(args: {
  client: RpcClient | null
  pairedHostId: string | undefined
  hostCapabilities: readonly string[]
  listings: readonly HostBotListing[]
  collapsedGroups: ReadonlySet<string>
}): Pick<HostBotSectionInputs, 'pairedHostId' | 'chatTrees' | 'chatFolds' | 'chatSteps'> {
  const chatTrees = useHostBotChatTrees(args)
  const chatFolds = useBotChatFolds()
  const chatSteps = useBotChatSteps()
  const pairedHostId = args.pairedHostId ?? ''
  return useMemo(
    () => ({ pairedHostId, chatTrees, chatFolds, chatSteps }),
    [pairedHostId, chatTrees, chatFolds, chatSteps]
  )
}

/** Each listed, unfolded bot's chats, read when it unfolds, as the desktop reads its unfolded bots'.
 *  The paired host's bots re-read on a botsChanged that names them, a reconnect and the foreground;
 *  another server's, with each read of its listing (it sends the phone no notices). */
export function useHostBotChatTrees(args: {
  client: RpcClient | null
  hostCapabilities: readonly string[]
  listings: readonly HostBotListing[]
  collapsedGroups: ReadonlySet<string>
}): HostBotChatTrees {
  const { client, hostCapabilities, listings, collapsedGroups } = args
  const [trees, setTrees] = useState<HostBotChatTrees>(NO_TREES)
  const [reads] = useState(() => startBotChatTreeReads(setTrees))
  // The listing each server's bots were last read for: its `bots` list is new only on a read.
  const readFor = useRef(new Map<ExecutionHostId, unknown>())

  useEffect(() => () => reads.stop(), [reads])

  useEffect(() => {
    const wanted = new Map<string, WantedBotChatTree>()
    const reread: ExecutionHostId[] = []
    for (const listing of listings) {
      if (!client || listing.kind !== 'listed' || listing.offline) {
        continue
      }
      const { hostId } = listing
      const hostClient =
        hostId === LOCAL_EXECUTION_HOST_ID
          ? client
          : rpcClientForExecutionHost(client, hostCapabilities, hostId)
      if (!hostClient) {
        continue
      }
      for (const bot of listing.bots) {
        if (!collapsedGroups.has(hostBotFoldKey(hostId, bot.folderWorkspaceId))) {
          wanted.set(hostBotTreeKey(hostId, bot.id), { hostId, botId: bot.id, client: hostClient })
        }
      }
      if (hostId !== LOCAL_EXECUTION_HOST_ID && readFor.current.get(hostId) !== listing.bots) {
        readFor.current.set(hostId, listing.bots)
        reread.push(hostId)
      }
    }
    reads.want(wanted)
    reads.readWhere((bot) => reread.includes(bot.hostId))
  }, [reads, client, hostCapabilities, listings, collapsedGroups])

  useEffect(() => {
    if (!client) {
      return
    }
    const readPaired = (which: (botId: string) => boolean) =>
      reads.readWhere((bot) => bot.hostId === LOCAL_EXECUTION_HOST_ID && which(bot.botId))
    const foreground = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        readPaired(() => true)
      }
    })
    const unsubscribe = subscribeSharedClientEvents(client, (event) => {
      // In the background it waits for the foreground's read.
      if (AppState.currentState !== 'active') {
        return
      }
      if (event.type === 'ready' && 'replayed' in event) {
        readPaired(() => true)
      } else if (event.type === 'botsChanged') {
        const scope = readBotChangeScope(event)
        readPaired((botId) => botChangeConcerns(scope, { botId, kinds: BOT_WORK_KINDS }))
      }
    })
    return () => {
      foreground.remove()
      unsubscribe()
    }
  }, [reads, client])

  return trees
}
