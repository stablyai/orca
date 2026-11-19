// The bot panel: the desktop's right panel as a full-height sheet, on a host that serves items to phones.
// Tabs Items · Chats · Files, Items first; the gear pushes the bot's settings and an item opens as a page
// with its comment box docked. Its own toast sits over the sheet, just above the home indicator, or just
// above the comment box on an item's page. (An older host keeps MobileBotSheet.)
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ScrollView, View } from 'react-native'
import {
  BOT_ITEM_NO_FILTER,
  botItemFilterChat,
  botItemChats,
  botItemStaleDays,
  botItemsNeedingOwner,
  type BotItemFilter
} from '../../../src/shared/bots/bot-item-groups'
import { usePhoneNeedsYouAsks } from './items/phone-needs-you-asks'
import { phoneBotItemFilterLabel } from './items/phone-bot-item-filter-label'
import type { BotItem } from '../../../src/shared/bots/bot-items'
import type { BotChatTreeWorker } from '../../../src/shared/bots/bot-chat-tree'
import { lookAroundSupported } from '../../../src/shared/bots/bot-look-around'
import { BottomDrawer, OptionPager, useOptionPager } from '../components/bottom-drawer/BottomDrawer'
import { BottomDrawerModalHost } from '../components/bottom-drawer/bottom-drawer-modal-host'
import { TransientToast, useTransientToast } from '../components/feedback/TransientToast'
import { MobileFileExplorerPanel } from '../files/explorer/MobileFileExplorerPanel'
import { useNow } from '../hooks/use-now'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors, spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { MobileBotActivityTab } from './MobileBotActivityTab'
import { MobileBotAutomationsTab } from './MobileBotAutomationsTab'
import { MobileBotSettingsTab } from './MobileBotSettingsTab'
import { MobileBotUpNext } from './MobileBotUpNext'
import { botAgentLabel } from './mobile-bot-sheet-copy'
import type { BotChatTreeActions } from './MobileBotChatTree'
import type { BotAccessRequests } from './use-bot-access-requests'
import { useBotUpNext } from './use-bot-up-next'
import type { RouteBot } from './use-route-bot'
import { usePhoneBotChatTree } from './use-phone-bot-chat-tree'
import { markBotItemsOpened } from './items/bot-item-operations'
import { MobileBotItemPage } from './items/MobileBotItemPage'
import { MobileBotItemSheets, type BotItemSheet } from './items/MobileBotItemSheets'
import { MobileBotItemSelectionBar } from './items/MobileBotItemRow'
import { MobileBotItemsTab } from './items/MobileBotItemsTab'
import {
  MobileBotItemsFilterSheet,
  MobileBotPanelHeader,
  type PanelTab
} from './MobileBotPanelHeader'
import { useBotItemMoves } from './items/use-bot-item-moves'
import { usePhoneBotItems } from './items/use-phone-bot-items'
import { openBotItemWorker } from './items/bot-item-worker-open'

type PanelPage = 'settings' | `item:${string}`

export type BotPanelOpen = { tab: 'items' } | { item: string }

export function MobileBotPanel(props: {
  /** What the panel opens on; null while closed. */
  open: BotPanelOpen | null
  onClose: () => void
  routeBot: RouteBot
  client: RpcClient | null
  /** The host answers: off, writes wait and say so. */
  online: boolean
  /** The computer the bot runs on, for "Studio Mac is offline." */
  hostName: string
  hostId: string
  worktreeId: string
  /** The phone's key for the bot's host (`hostBotsKey`). */
  hostKey: string
  /** The Needs you count the bot list carries, until the panel reads the items. */
  listNeedsYou: number
  onNewAutomation: (() => void) | null
  accessRequests: BotAccessRequests | null
  onStartSuggestion: ((ask: string) => void) | null
  treeActions: BotChatTreeActions
  /** Opens an item's chat; the panel closes first. */
  onOpenItemChat: (item: BotItem) => void
  /** Opens a file an item links; a path outside the bot's folder is refused with a toast. */
  onOpenFile: (path: string, showToast: (message: string) => void) => void
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const visible = props.open !== null
  const { bot } = props.routeBot
  const [tab, setTab] = useState<PanelTab>('items')
  const pager = useOptionPager<PanelPage>()
  const { message, showToast } = useTransientToast()
  const [sheet, setSheet] = useState<BotItemSheet | null>(null)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [filter, setFilter] = useState<BotItemFilter>(BOT_ITEM_NO_FILTER)
  const [filtering, setFiltering] = useState(false)
  const [boxHeight, setBoxHeight] = useState(0)
  const now = useNow(60_000, visible)

  // Each open lands where it was asked: the list, or one item's page (the pager animates, so it moves
  // in an effect).
  const [opened, setOpened] = useState(props.open)
  if (props.open !== opened) {
    setOpened(props.open)
    setSelected(new Set())
    if (props.open) {
      setTab('items')
    }
  }
  const { open: openPage, forget } = pager
  useEffect(() => {
    if (props.open && 'item' in props.open) {
      openPage(`item:${props.open.item}`)
    } else if (props.open) {
      forget()
    }
  }, [props.open, openPage, forget])

  const items = usePhoneBotItems({
    client: props.client,
    botId: bot.id,
    chatId: botItemFilterChat(filter),
    showing: visible,
    reads: props.routeBot.itemReads
  })
  const allItems = usePhoneBotItems({
    client: props.client,
    botId: bot.id,
    chatId: null,
    showing: visible && filter.chatIds !== null,
    reads: props.routeBot.itemReads
  })
  const selectedItems = [...(items.read?.items ?? []), ...items.items].filter((item) =>
    selected.has(item.uid)
  )
  // A filter shows other items, so it starts a new selection.
  const changeFilter = (next: BotItemFilter) => {
    setSelected(new Set())
    setFilter(next)
  }
  const staleDays = botItemStaleDays(bot.itemsStale)
  const tree = usePhoneBotChatTree({
    client: props.client,
    botId: bot.id,
    showing: visible,
    reads: props.routeBot.reads
  })
  const { shown: asks, count: needsYou } = usePhoneNeedsYouAsks({
    chats: tree.kind === 'tree' ? tree.chats : null,
    workers: props.routeBot.activity?.workers,
    items: (filter.chatIds === null ? items.read : allItems.read)?.items,
    filter,
    // A first read that failed counts no items, as nothing was read; the bot list's count stands in until one lands.
    itemCount:
      items.read && filter.chatIds === null
        ? botItemsNeedingOwner(items.read.items, staleDays, now)
        : items.error !== null && !items.read
          ? 0
          : props.listNeedsYou
  })

  // The seen mark as the panel opened: rows changed since keep their dot while it stays open; opening
  // moves the bot's one mark (shared with the desktop) once the first read says where it was.
  const [seenAtOpen, setSeenAtOpen] = useState<string | null>(null)
  const marked = useRef(false)
  if (!visible && seenAtOpen !== null) {
    setSeenAtOpen(null)
  }
  if (visible && seenAtOpen === null && items.read) {
    setSeenAtOpen(items.read.seenEventId)
  }
  useEffect(() => {
    if (!visible) {
      marked.current = false
      return
    }
    if (seenAtOpen !== null && !marked.current && props.client) {
      marked.current = true
      markBotItemsOpened(props.client, bot.id)
    }
  }, [visible, seenAtOpen, props.client, bot.id])

  const upNext = useBotUpNext({
    client: props.client,
    botId: bot.id,
    upNext: props.routeBot.activity?.upNext,
    showing: visible,
    showToast,
    onStart: props.onStartSuggestion,
    refresh: props.routeBot.refresh
  })
  const moves = useBotItemMoves({ client: props.client, hostName: props.hostName, showToast })
  // A write the host took ends the selection it came from.
  const clearOnWrite = (ok: boolean): boolean => {
    if (ok) {
      setSelected(new Set())
    }
    return ok
  }

  const chats = useMemo(
    () =>
      botItemChats(
        (allItems.read ?? items.read)?.items ?? [],
        tree.kind === 'tree' ? tree.chats : []
      ),
    [allItems.read, items.read, tree]
  )
  const filterLabel = phoneBotItemFilterLabel(filter, chats, t)

  const openWorker = (worker: BotChatTreeWorker) =>
    openBotItemWorker(worker, {
      client: props.client,
      loaded:
        tree.kind === 'tree'
          ? tree.chats.flatMap((chat) => [...chat.running, ...chat.finished])
          : [],
      open: props.treeActions.openWorker,
      current: () => visible,
      showToast
    })

  const switchTab = (next: PanelTab) => {
    setSelected(new Set())
    setTab(next)
  }
  const after = (
    <>
      {props.routeBot.activity ? (
        <MobileBotAutomationsTab
          client={props.client}
          bot={bot}
          rows={props.routeBot.activity.automations ?? null}
          showToast={showToast}
          onNewAutomation={props.onNewAutomation}
        />
      ) : null}
      {props.routeBot.activity?.upNext ? (
        <MobileBotUpNext
          botName={bot.name}
          upNext={props.routeBot.activity.upNext}
          actions={upNext}
        />
      ) : null}
    </>
  )

  let body: ReactNode
  if (tab === 'items') {
    body = (
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={
          selectedItems.length > 0 ? styles.scrollSelecting : styles.scrollContent
        }
        showsVerticalScrollIndicator={false}
      >
        <MobileBotItemsTab
          botName={bot.name}
          items={items}
          filter={filter}
          filterLabel={filterLabel}
          onClearFilter={() => changeFilter(BOT_ITEM_NO_FILTER)}
          staleDays={staleDays}
          seenEventId={seenAtOpen ?? items.read?.seenEventId ?? 'e0'}
          now={now}
          online={props.online}
          hostName={props.hostName}
          selected={selected}
          onSelected={setSelected}
          onOpen={(item) => pager.open(`item:${item.uid}`)}
          setSheet={setSheet}
          after={after}
          asks={asks}
          askOpeners={{ chat: props.treeActions.openChat, worker: openWorker }}
          client={props.client}
          showToast={showToast}
        />
      </ScrollView>
    )
  } else if (tab === 'chats') {
    body = (
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <MobileBotActivityTab
          bot={bot}
          hostKey={props.hostKey}
          activity={props.routeBot.activity}
          tree={tree}
          treeActions={props.treeActions}
          upNextActions={upNext}
          loading={props.routeBot.activityLoading}
          error={props.routeBot.activityError ?? null}
          onRetry={props.routeBot.refresh}
          online={props.online}
          hostName={props.hostName}
          withoutUpNext
        />
      </ScrollView>
    )
  } else {
    body = (
      <View style={styles.scroll}>
        <MobileFileExplorerPanel
          hostId={props.hostId}
          worktreeId={props.worktreeId}
          name={bot.name}
          embedded
          headerless
          onRequestClose={props.onClose}
        />
      </View>
    )
  }

  const main = (
    <View style={styles.main}>
      <MobileBotPanelHeader
        name={bot.name}
        sub={`${botAgentLabel(bot.agent)} · ${props.hostName}`}
        tab={tab}
        onTab={switchTab}
        needsYou={needsYou}
        filterActive={filterLabel !== null}
        onFilter={() => setFiltering(true)}
        onSettings={() => pager.open('settings')}
      />
      {body}
      {tab === 'items' && selectedItems.length > 0 ? (
        <MobileBotItemSelectionBar
          count={selectedItems.length}
          onMove={() => setSheet({ kind: 'move', items: selectedItems })}
          onClear={() => setSelected(new Set())}
        />
      ) : null}
    </View>
  )

  const page = pager.page
  const pageNode =
    page === 'settings' ? (
      <View style={styles.page}>
        <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false}>
          <MobileBotSettingsTab
            onBack={{
              label: t('bots.panel.backTo', 'Back to {{name}}', { name: bot.name }),
              onPress: pager.close
            }}
            routeBot={props.routeBot}
            client={props.client}
            showToast={showToast}
            accessRequests={props.accessRequests}
            lookAround={
              lookAroundSupported(bot.agent)
                ? { onLookNow: upNext.lookNow, busy: upNext.busy }
                : null
            }
          />
        </ScrollView>
      </View>
    ) : page?.startsWith('item:') ? (
      <MobileBotItemPage
        client={props.client}
        bot={bot}
        uid={page.slice('item:'.length)}
        reads={props.routeBot.itemReads}
        online={props.online}
        hostName={props.hostName}
        onBack={pager.close}
        setSheet={setSheet}
        onOpenChat={props.onOpenItemChat}
        onOpenWorker={openWorker}
        onOpenFile={(path) => props.onOpenFile(path, showToast)}
        onCommentBoxHeight={setBoxHeight}
      />
    ) : null

  const onItemPage = page?.startsWith('item:') === true
  return (
    <BottomDrawerModalHost>
      <BottomDrawer
        visible={visible}
        onClose={props.onClose}
        fillAvailable
        contentScrollable={false}
        dragContentToDismiss={false}
      >
        <View style={styles.root}>
          <OptionPager pager={pager} main={main} page={pageNode} fill />
          {/* The sheet already sits spacing.lg above the home indicator; the toast lands there too. */}
          <TransientToast message={message} bottomInset={onItemPage ? boxHeight : -spacing.lg} />
        </View>
      </BottomDrawer>
      <MobileBotItemSheets
        sheet={sheet}
        setSheet={setSheet}
        online={props.online}
        hostName={props.hostName}
        onSelect={
          tab === 'items' && !onItemPage ? (item) => setSelected(new Set([item.uid])) : null
        }
        onOpenChat={props.onOpenItemChat}
        move={async (moved, to, reason) => clearOnWrite(await moves.move(moved, to, reason))}
        snooze={async (snoozed, until) => clearOnWrite(await moves.snooze(snoozed, until))}
      />
      <MobileBotItemsFilterSheet
        visible={filtering}
        onClose={() => setFiltering(false)}
        chats={chats}
        filter={filter}
        onFilter={changeFilter}
      />
    </BottomDrawerModalHost>
  )
}

const styles = themedStyleSheet(() => ({
  root: { flex: 1 },
  main: { flex: 1 },
  page: { flex: 1, backgroundColor: colors.sheetSurface },
  scroll: { flex: 1 },
  scrollContent: { paddingBottom: spacing.lg },
  scrollSelecting: { paddingBottom: 72 }
}))
