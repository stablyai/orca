import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState } from 'react-native'
import type { BotRowStatus } from '../../../src/shared/bots/bot-row-status'
import { folderWorkspaceKey } from '../../../src/shared/workspace/identity/workspace-scope'
import {
  readHostMethodReply,
  type HostMethodReply
} from '../host-screen/sidebar-feed/host-sidebar-feed-operations'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import type { ConnectionState } from '../transport/connection/connection-state'
import { botActivityRead, type SheetActivity, type SheetBot } from './bot-sheet-operations'
import { mobileBotAvatarSource, type MobileBotAvatarSource } from './host-bot-row-facts'
import { startHostBotRefresh } from './host-bot-refresh'
import {
  BOT_VIEW_KINDS,
  botChangeConcerns,
  type BotChangeKind,
  type BotChangeScope
} from '../../../src/shared/bots/bot-change-scope'
import { publishHostBot, useHostBotsEntry } from './host-bot-store'
import { readHostBots } from './host-bots-read'

export type RouteBot = {
  bot: SheetBot
  avatar: MobileBotAvatarSource
  activity: SheetActivity | null
  activityLoading?: boolean
  /** Null while the last read landed; why it failed otherwise, empty when nothing said why. */
  activityError?: string | null
  /** The status the host list rolled up for this bot; null until the list has drawn it. */
  listStatus: BotRowStatus | null
  /** Its Needs you items that aren't stale, as the host's bot list counts them. */
  needsYou: number
  /** Takes the host's reply to an edit, so every screen shows it at once. */
  applyBot: (bot: SheetBot) => void
  /** Re-reads the bot and its Activity, e.g. as the sheet opens over a newer desktop edit. */
  refresh: () => void
  /** Counts this route's reads (botsChanged, reconnect, foreground), so views of more of the bot re-read with it. */
  reads: number
  /** Counts the reads that may have moved its items (an items or workers notice, reconnect,
   *  foreground), so its item list and page re-read with these only, not with each pane's phase. */
  itemReads: number
  /** The store key for the route's execution host (`hostBotsKey`). */
  hostKey: string
}

/** The notices that can change what an item list or page shows: its items, and their linked workers. */
const ITEM_KINDS: readonly BotChangeKind[] = ['items', 'workers']

/** The bot whose home this route is, from the host's shared bot store; null on any other route or an older host. */
export function useRouteBot({
  client,
  connState,
  worktreeId,
  enabled,
  hostKey
}: {
  client: RpcClient | null
  connState: ConnectionState
  worktreeId: string
  enabled: boolean
  /** The store key for the route's execution host (`hostBotsKey`). */
  hostKey: string
}): RouteBot | null {
  const entry = useHostBotsEntry(enabled ? hostKey : null)
  const bot =
    entry?.bots.find(
      (candidate) => folderWorkspaceKey(candidate.folderWorkspaceId) === worktreeId
    ) ?? null
  const scope = `${hostKey}\n${worktreeId}`
  const [activityScope, setActivityScope] = useState(scope)
  const [activity, setActivity] = useState<SheetActivity | null>(null)
  const [activityLoading, setActivityLoading] = useState(false)
  const [activityError, setActivityError] = useState<string | null>(null)
  const [reads, setReads] = useState(0)
  const [itemReads, setItemReads] = useState(0)
  const previousScope = useRef(scope)
  const readRef = useRef<() => void>(() => {})
  const ready = enabled && client !== null && connState === 'connected'

  useEffect(() => {
    if (!ready || !client) {
      return
    }
    if (previousScope.current !== scope) {
      previousScope.current = scope
      setActivity(null)
      setActivityError(null)
    }
    let current = true
    let listedBots = false
    let routeBotId: string | null = null
    let stop = (): void => {}
    // One read at a time; a change during it reads once more after.
    let reading = false
    let again = false
    // A change since the last read that may have moved the bot's items: the next read says so.
    let itemsDue = false
    // No scope: a reconnect, the foreground or an older host's notice, which may cover anything.
    const read = (changed?: BotChangeScope): void => {
      itemsDue ||=
        !changed ||
        botChangeConcerns(changed, {
          kinds: ITEM_KINDS,
          ...(routeBotId ? { botId: routeBotId } : {})
        })
      if (reading) {
        again = true
        return
      }
      void run()
    }
    const run = async (): Promise<void> => {
      reading = true
      if (current) {
        setActivityScope(scope)
        setActivityLoading(true)
        setActivityError(null)
      }
      try {
        const listed = await readHostBots(client, hostKey)
        if (listed.kind === 'unreadable' && current) {
          setActivityError('')
        }
        if (listed.kind === 'no-capability') {
          // A host without bots for phones has nothing to refresh.
          again = false
          stop()
          return
        }
        listedBots = listed.kind === 'bots'
        const found =
          listed.kind === 'bots'
            ? listed.bots.find(
                (entry) => folderWorkspaceKey(entry.folderWorkspaceId) === worktreeId
              )
            : undefined
        if (!current || !found) {
          return
        }
        routeBotId = found.id
        const answer = await botActivityRead.request(client, { botId: found.id }).then(
          (reply) => readHostMethodReply(reply, botActivityRead.interpret),
          (error: unknown): HostMethodReply<never> => ({
            kind: 'failed',
            message: errorText(error)
          })
        )
        // A failed read keeps what the sheet shows rather than blanking it.
        if (current) {
          setReads((count) => count + 1)
          if (itemsDue) {
            itemsDue = false
            setItemReads((count) => count + 1)
          }
          if (answer.kind === 'answered') {
            setActivity(answer.value.activity)
          } else {
            setActivityError(answer.kind === 'failed' ? (answer.message ?? '') : '')
          }
        }
      } catch (error) {
        if (current) {
          setActivityError(errorText(error))
        }
      } finally {
        if (current) {
          setActivityLoading(false)
        }
        reading = false
        if (again && current) {
          again = false
          void run()
        }
      }
    }
    readRef.current = () => read()
    stop = startHostBotRefresh({
      client,
      appState: AppState,
      refresh: read,
      listed: () => listedBots,
      // Until the first read finds the bot, every bot's change could be its. `access`: its waiting
      // access requests re-read with each route read.
      interest: () => ({
        ...(routeBotId ? { botId: routeBotId } : {}),
        kinds: [...BOT_VIEW_KINDS, 'items', 'access']
      })
    })
    return () => {
      current = false
      readRef.current = () => {}
      stop()
    }
  }, [ready, client, worktreeId, hostKey, scope])

  const applyBot = useCallback((next: SheetBot) => publishHostBot(hostKey, next), [hostKey])
  const refresh = useCallback(() => readRef.current(), [])

  if (!enabled || !bot) {
    return null
  }
  return {
    bot,
    avatar: mobileBotAvatarSource(bot),
    activity: activityScope === scope ? activity : null,
    activityLoading: activityScope === scope ? activityLoading : ready,
    activityError: activityScope === scope ? activityError : null,
    listStatus: entry?.statusByBotId.get(bot.id) ?? null,
    needsYou: entry?.needsYou[bot.id] ?? 0,
    applyBot,
    refresh,
    reads,
    itemReads,
    hostKey
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : ''
}
