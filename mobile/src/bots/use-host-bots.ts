import { useEffect, useMemo, useRef, useState } from 'react'
import { BOTS_CREATE_RUNTIME_CAPABILITY } from '../../../src/shared/bot-runtime-capabilities'
import {
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../src/shared/execution-host/execution-host'
import type { MobileRelayHost } from '../../../src/shared/remote-runtime/relay/mobile-relay-hosts-contract'
import { readHostMethodReply } from '../host-screen/sidebar-feed/host-sidebar-feed-operations'
import { rpcClientForExecutionHost } from '../worktree/execution-hosts/execution-host-scoped-rpc-client'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import type { ConnectionState } from '../transport/connection/connection-state'
import { newBotRefusal, shownHostBotListings, type HostBotListing } from './host-bot-listing'
import { listingNeedsGroupsRetry, mergeHostBotListing } from './host-bot-listing-merge'
import {
  botHomeLinksRead,
  botOwnChatsRead,
  botUpNextUnseenRead,
  workspaceLineageRead
} from './host-bots-operations'
import { hostBotsKey, readHostBots } from './host-bots-read'
import { groupList } from './bot-group-operations'
import { readHostAccessRequests } from './bot-access-request-operations'
import { HOST_REFRESH_FALLBACK_MS } from '../worktree/execution-hosts/host-worktree-refresh'
import { useKeptServerBotListings } from './use-kept-server-bot-listings'
import { createHostCountTimers } from './host-bot-count-timers'

const NO_LISTINGS: readonly HostBotListing[] = []

export type ListingTarget = {
  hostId: ExecutionHostId
  hostLabel: string
  client: RpcClient
  key: string
  /** The route reaches the host's bots.create: false through a paired desktop too old to relay it. */
  relaysCreate: boolean
  installationId?: string
}

/** A host's bots with their workers' lineage; a server older than the page gets a line instead. */
export async function readHostBotListing(
  target: ListingTarget,
  isServer: boolean,
  /** Whether to read thread links and side chats too. */
  threads = true
): Promise<HostBotListing | null> {
  const bots = await readHostBots(target.client, target.key)
  if (bots.kind === 'no-capability') {
    return isServer
      ? { kind: 'update-needed', hostId: target.hostId, hostLabel: target.hostLabel }
      : null
  }
  if (bots.kind !== 'bots') {
    return null
  }
  // Only a host with bots is asked for their workers' lineage. A failed ancillary read must not
  // hide the bot list that already arrived.
  const lineageReply = await workspaceLineageRead.request(target.client).catch(() => null)
  const lineage = lineageReply && readHostMethodReply(lineageReply, workspaceLineageRead.interpret)
  const links = lineage?.kind === 'answered' ? lineage.value : null
  const createRefusal = newBotRefusal(bots, target.relaysCreate)
  if (!links) {
    return {
      kind: 'listed',
      waits: bots.waits,
      needsYou: bots.needsYou,
      needsYouChangeInMs: bots.needsYouChangeInMs,
      hostId: target.hostId,
      hostLabel: target.hostLabel,
      ...(target.installationId ? { installationId: target.installationId } : {}),
      bots: bots.bots,
      hideBotCreated: bots.hideBotCreated,
      view: bots.view,
      workspaceLineage: {},
      worktreeLineage: {},
      workerStatus: 'unavailable',
      ...(createRefusal ? { createRefusal } : {}),
      takesTemplates: bots.takesTemplates
    }
  }
  const [unseenReply, linksReply, ownChatsReply, accessRequests] = await Promise.all([
    botUpNextUnseenRead.request(target.client).catch(() => null),
    threads ? botHomeLinksRead.request(target.client).catch(() => null) : null,
    threads ? botOwnChatsRead.request(target.client).catch(() => null) : null,
    // Off, the host lists no bots and its list would ask the cloud for nothing it shows.
    bots.enabled && bots.bots.length > 0 ? readHostAccessRequests(target.client) : null
  ])
  const ownChats = ownChatsReply && readHostMethodReply(ownChatsReply, botOwnChatsRead.interpret)
  const threadLinks = linksReply && readHostMethodReply(linksReply, botHomeLinksRead.interpret)
  const groups = await groupList
    .request(target.client, undefined)
    .then((reply) => groupList.interpret(reply).groups)
    .catch(() => null)
  const unseen = unseenReply && readHostMethodReply(unseenReply, botUpNextUnseenRead.interpret)
  return {
    kind: 'listed',
    ...(unseen?.kind === 'answered' ? { unseen: unseen.value.unseen } : {}),
    ...(threadLinks?.kind === 'answered' ? { links: threadLinks.value } : {}),
    ...(ownChats?.kind === 'answered' ? { ownChats: ownChats.value.chats } : {}),
    ...(accessRequests ? { accessRequests } : {}),
    waits: bots.waits,
    needsYou: bots.needsYou,
    needsYouChangeInMs: bots.needsYouChangeInMs,
    hostId: target.hostId,
    hostLabel: target.hostLabel,
    ...(target.installationId ? { installationId: target.installationId } : {}),
    bots: bots.bots,
    hideBotCreated: bots.hideBotCreated,
    view: bots.view,
    workspaceLineage: links.workspaceLineage,
    worktreeLineage: links.lineage,
    workerStatus: 'available',
    ...(createRefusal ? { createRefusal } : {}),
    takesTemplates: bots.takesTemplates,
    // Groups read on their own: a failed read leaves them out, and the list reads again.
    ...(groups ? { groups } : {})
  }
}

type BotListingReads = {
  /** Reads the listed hosts' listings, or every host's; without `threads`, each keeps its last
   *  thread links and side chats. */
  read: (hostIds?: readonly ExecutionHostId[], threads?: boolean) => void
  /** Reads again the hosts whose last read listed their bots but not their groups. */
  readUnreadGroups: () => void
  stop: () => void
}

/** One host's listing is read once at a time: asked again while a read is out, it reads once more
 *  after, so the answer postdates the ask without reads piling up behind each other. */
function startBotListingReads(args: {
  hosts: readonly ListingTarget[]
  setListings: (update: (previous: readonly HostBotListing[]) => readonly HostBotListing[]) => void
  setGroupsUnread: (unread: boolean) => void
}): BotListingReads {
  const { hosts, setListings, setGroupsUnread } = args
  // Each host with a read out, and whether it was asked again meanwhile.
  const askedAgain = new Map<ExecutionHostId, boolean>()
  // Each host whose threads' facts the next read owes.
  const threadsOwed = new Set<ExecutionHostId>()
  const groupsUnread = new Set<ExecutionHostId>()
  // Each host's read at its next Needs you change, which nothing else announces.
  const countTimers = createHostCountTimers((host: ListingTarget) => void readHost(host, false))
  let stopped = false
  const apply = (
    hostId: ExecutionHostId,
    listing: HostBotListing | null,
    threads: boolean
  ): void => {
    // A failed read keeps the host's last listing, and a failed groups read its last groups, so
    // neither flashes back into folders. Hosts this read doesn't cover keep theirs: a server that
    // went down lists its last read, dimmed. A read without threads keeps the last threads' facts.
    if (listing) {
      setListings((previous) => {
        return mergeHostBotListing(previous, listing, threads)
      })
    }
    if (listingNeedsGroupsRetry(listing)) {
      groupsUnread.add(hostId)
    } else {
      groupsUnread.delete(hostId)
    }
    setGroupsUnread(groupsUnread.size > 0)
  }
  const readHost = async (host: ListingTarget, threads: boolean): Promise<void> => {
    if (threads) {
      threadsOwed.add(host.hostId)
    }
    if (askedAgain.has(host.hostId)) {
      askedAgain.set(host.hostId, true)
      return
    }
    do {
      askedAgain.set(host.hostId, false)
      const withThreads = threadsOwed.delete(host.hostId)
      const listing = await readHostBotListing(
        host,
        host.hostId !== LOCAL_EXECUTION_HOST_ID,
        withThreads
      ).catch(() => null)
      if (stopped) {
        return
      }
      apply(host.hostId, listing, withThreads)
      // A failed or unlisted read drops the timer; the read that follows a reconnect sets it again.
      countTimers.readAfter(host, listing?.kind === 'listed' ? listing : null)
    } while (askedAgain.get(host.hostId))
    askedAgain.delete(host.hostId)
  }
  const read = (only?: readonly ExecutionHostId[], threads = true): void => {
    for (const host of hosts) {
      if (!only || only.includes(host.hostId)) {
        void readHost(host, threads)
      }
    }
  }
  return {
    read,
    readUnreadGroups: () => read([...groupsUnread]),
    stop: () => {
      stopped = true
      countTimers.stop()
    }
  }
}

/** Each host's bots for its list: the paired host's, and every relayed server's, as `shownHostBotListings` keeps them. */
export function useHostBots(args: {
  client: RpcClient | null
  /** The paired host's route id; each host's bots are kept under it for every screen. */
  pairedHostId: string | undefined
  connState: ConnectionState
  hostCapabilities: readonly string[]
  hostLabel: string
  serverHosts: readonly MobileRelayHost[]
  /** Names every row, so it changes when a workspace or folder comes or goes, as a bot or its work may have. */
  rowsKey: string
  /** Changes on a reconnect and the foreground: every host re-reads. */
  changeKey: number
  /** Changes on the paired host's botsChanged, which speaks for its own bots: only it re-reads. */
  pairedChangeKey: number
  /** Changes with `pairedChangeKey` when that change may touch its bots' chats or threads: only
   *  then does it re-read their thread links and side chats. */
  pairedThreadsKey?: number
}): readonly HostBotListing[] {
  const {
    client,
    pairedHostId,
    connState,
    hostCapabilities,
    hostLabel,
    serverHosts,
    rowsKey,
    changeKey,
    pairedChangeKey,
    pairedThreadsKey = 0
  } = args
  const [listings, setListings] = useState<readonly HostBotListing[]>(NO_LISTINGS)
  // Another paired computer's screen starts from nothing; a disconnect keeps the last read.
  const [listedFor, setListedFor] = useState(pairedHostId)
  if (listedFor !== pairedHostId) {
    setListedFor(pairedHostId)
    setListings(NO_LISTINGS)
  }
  const [groupsUnread, setGroupsUnread] = useState(false)
  const [groupsRetry, setGroupsRetry] = useState(0)
  const reads = useRef<BotListingReads | null>(null)
  const readyServers = serverHosts.filter((host) => host.relay === 'ready')
  const serversKey = readyServers
    .map((host) => `${host.hostId}\n${host.label}\n${host.installationId ?? ''}`)
    .join('\n')
  const targets = useMemo((): { local: ListingTarget | null; servers: ListingTarget[] } => {
    if (!client || !pairedHostId || connState !== 'connected') {
      return { local: null, servers: [] }
    }
    const local: ListingTarget = {
      hostId: LOCAL_EXECUTION_HOST_ID,
      hostLabel,
      client,
      key: hostBotsKey(pairedHostId),
      // Its own build decides (bots.create.v1, read with its bots); nothing relays it.
      relaysCreate: true
    }
    const relaysCreate = hostCapabilities.includes(BOTS_CREATE_RUNTIME_CAPABILITY)
    const servers = readyServers.flatMap((host) => {
      const scoped = rpcClientForExecutionHost(client, hostCapabilities, host.hostId)
      return scoped
        ? [
            {
              hostId: host.hostId,
              hostLabel: host.label,
              client: scoped,
              key: hostBotsKey(pairedHostId, host.hostId),
              relaysCreate,
              ...(host.installationId ? { installationId: host.installationId } : {})
            }
          ]
        : []
    })
    return { local, servers }
    // serversKey stands for the ready servers, whose array changes on every health update.
  }, [client, pairedHostId, connState, hostCapabilities, hostLabel, serversKey])

  // New targets start their own reads; a late answer from the old ones is dropped.
  useEffect(() => {
    const hosts = [...(targets.local ? [targets.local] : []), ...targets.servers]
    setGroupsUnread(false)
    if (hosts.length === 0) {
      return
    }
    const started = startBotListingReads({
      hosts,
      setListings,
      setGroupsUnread
    })
    reads.current = started
    return () => {
      started.stop()
      reads.current = null
    }
  }, [targets])

  useEffect(() => {
    reads.current?.read()
  }, [targets, rowsKey, changeKey])

  const readPairedChange = useRef({ change: pairedChangeKey, threads: pairedThreadsKey })
  useEffect(() => {
    const last = readPairedChange.current
    if (last.change === pairedChangeKey) {
      return
    }
    readPairedChange.current = { change: pairedChangeKey, threads: pairedThreadsKey }
    reads.current?.read([LOCAL_EXECUTION_HOST_ID], last.threads !== pairedThreadsKey)
  }, [pairedChangeKey, pairedThreadsKey])

  // A failed groups read is read again on its own, with no change to wait for.
  useEffect(() => {
    if (!groupsUnread) {
      return
    }
    const retry = setTimeout(() => {
      setGroupsRetry((count) => count + 1)
      reads.current?.readUnreadGroups()
    }, HOST_REFRESH_FALLBACK_MS)
    return () => clearTimeout(retry)
  }, [groupsUnread, groupsRetry])

  useKeptServerBotListings({ pairedHostId, serverHosts, listings, setListings })

  return useMemo(() => shownHostBotListings(listings, serverHosts), [listings, serverHosts])
}
