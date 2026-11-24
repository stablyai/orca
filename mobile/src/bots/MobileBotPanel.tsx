// The bot panel: the desktop's right panel as a full-height sheet, on a host that serves items to phones.
// Tabs Items · Chats · Files, Items first; the gear pushes the bot's settings and an item opens as a page
// with its comment box docked. Its own toast sits over the sheet, just above the home indicator, or just
// above the comment box on an item's page.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ScrollView, View, type ScrollViewInstance } from 'react-native'
import {
  BOT_ITEM_NO_FILTER,
  botItemStaleDays,
  type BotItemFilter
} from '../../../src/shared/bots/bot-item-groups'
import { usePhonePanelNeedsYouAsks } from './items/phone-needs-you-asks'
import type { BotItem } from '../../../src/shared/bots/bot-items'
import type { BotChatTreeWorker } from '../../../src/shared/bots/bot-chat-tree'
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
import { MobileBotSettingsTab } from './MobileBotSettingsTab'
import type { BotSettingsTarget } from './MobileBotSettingsRoot'
import { SheetPageScrollContext } from '../components/nav-bar/sheet-page-scroll'
import { MobileBotUpNext } from './MobileBotUpNext'
import { botAgentLabel } from './mobile-bot-sheet-copy'
import type { BotChatTreeActions } from './MobileBotChatTree'
import type { BotAccessRequests } from './use-bot-access-requests'
import { useBotUpNext } from './use-bot-up-next'
import type { RouteBot } from './use-route-bot'
import { usePhoneBotChatTree } from './use-phone-bot-chat-tree'
import { useBotItemsSeenAtOpen } from './items/use-bot-items-seen-at-open'
import { MobileBotItemPage } from './items/MobileBotItemPage'
import { MobileBotItemSheets, type BotItemSheet } from './items/MobileBotItemSheets'
import { MobileBotItemSelectionBar } from './items/MobileBotItemRow'
import { MobileBotItemsTab } from './items/MobileBotItemsTab'
import { MobileBotPanelHeader, type PanelTab } from './MobileBotPanelHeader'
import { useBotItemMoves } from './items/use-bot-item-moves'
import { usePhoneBotItems } from './items/use-phone-bot-items'
import { usePhoneBotItemWalk } from './items/use-phone-bot-item-walk'
import { openBotItemWorker } from './items/bot-item-worker-open'
import { useBotAccessDecisionSheet } from './MobileBotAccessDecision'
import { useBotPanelAutomations } from './use-bot-panel-automations'
import { useMobileBotChatDelete } from './MobileBotChatDelete'

type PanelPage = 'settings' | `item:${string}` | `automation:${string}`

export type BotPanelOpen =
  | { tab: 'items' }
  | { item: string }
  | { access: string }
  /** Settings, on one of its pages. */
  | { settings: BotSettingsTarget }
  | { automation: string }

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
  /** Drafts a message in the bot's chat (Edit in chat); the panel closes first. */
  onAskInChat: ((draft: string) => void) | null
  /** Opens an automation's runs on the Automations page. */
  onViewRuns: ((automationId: string) => void) | null
  accessRequests: BotAccessRequests | null
  onStartSuggestion: ((ask: string) => void) | null
  treeActions: BotChatTreeActions
  /** Opens an item's chat; the panel closes first. */
  onOpenItemChat: (item: BotItem) => void
  /** Opens a file an item links; a path outside the bot's folder is refused with a toast. */
  onOpenFile: (path: string, showToast: (message: string) => void) => void
  home: Parameters<typeof MobileBotSettingsTab>[0]['home']
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const visible = props.open !== null
  const { bot } = props.routeBot
  const [tab, setTab] = useState<PanelTab>('items')
  const pager = useOptionPager<PanelPage>()
  const { message, showToast } = useTransientToast()
  const automations = useBotPanelAutomations(props, pager, showToast)
  const [sheet, setSheet] = useState<BotItemSheet | null>(null)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [filter, setFilter] = useState<BotItemFilter>(BOT_ITEM_NO_FILTER)
  const [boxHeight, setBoxHeight] = useState(0)
  // Each Settings open mounts it afresh on the page asked for; the gear opens its list.
  const [settings, setSettings] = useState(() => ({
    at: props.open && 'settings' in props.open ? props.open.settings : undefined,
    opens: 0
  }))
  const openSettings = (at: BotSettingsTarget | undefined) =>
    setSettings((current) => ({ at, opens: current.opens + 1 }))
  const showSettings = (at: BotSettingsTarget | undefined) => {
    openSettings(at)
    pager.open('settings')
  }
  const settingsScroll = useRef<ScrollViewInstance>(null)
  const now = useNow(60_000, visible)

  // Each open lands where it was asked: the list, or one item's page (the pager animates, so it moves
  // in an effect).
  const [opened, setOpened] = useState(props.open)
  if (props.open !== opened) {
    setOpened(props.open)
    setSelected(new Set())
    if (props.open) {
      setTab('items')
      if ('settings' in props.open) {
        openSettings(props.open.settings)
      }
    }
  }
  const { open: openPage, forget } = pager
  useEffect(() => {
    if (props.open && 'item' in props.open) {
      openPage(`item:${props.open.item}`)
    } else if (props.open && 'settings' in props.open) {
      openPage('settings')
    } else if (props.open && 'automation' in props.open) {
      openPage(`automation:${props.open.automation}`)
    } else if (props.open) {
      forget()
    }
  }, [props.open, openPage, forget])

  const items = usePhoneBotItems({
    client: props.client,
    botId: bot.id,
    chatIds: null,
    showing: visible,
    reads: props.routeBot.itemReads
  })
  const walk = usePhoneBotItemWalk({ items, pager, showToast, opened: props.open })
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
  const { review, sheet: accessSheet } = useBotAccessDecisionSheet(props, bot, showToast)
  const deleteChat = useMobileBotChatDelete(props, automations.present, showToast)
  const { asks, count: needsYou } = usePhonePanelNeedsYouAsks({
    client: visible && pager.page !== 'settings' ? props.client : null,
    panel: props,
    chats: tree.kind === 'tree' ? tree.chats : null,
    items,
    staleDays,
    now
  })

  const seenAtOpen = useBotItemsSeenAtOpen(visible, items.read, props.client, bot.id)

  const upNext = useBotUpNext({
    client: props.client,
    botId: bot.id,
    upNext: props.routeBot.activity?.upNext,
    showing: visible,
    showToast,
    onStart: props.onStartSuggestion,
    refresh: props.routeBot.refresh,
    online: props.online
  })
  const moves = useBotItemMoves({ client: props.client, hostName: props.hostName, showToast })
  // A write the host took ends the selection it came from.
  const clearOnWrite = (ok: boolean): boolean => {
    if (ok) {
      setSelected(new Set())
    }
    return ok
  }

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
      {automations.tab}
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
          bot={bot}
          items={items}
          filter={filter}
          onClearFilter={() => changeFilter(BOT_ITEM_NO_FILTER)}
          staleDays={staleDays}
          seenEventId={seenAtOpen ?? items.read?.seenEventId ?? 'e0'}
          now={now}
          online={props.online}
          hostName={props.hostName}
          selected={selected}
          onSelected={setSelected}
          onOpen={walk.open}
          setSheet={setSheet}
          after={after}
          asks={asks}
          askOpeners={{
            chat: props.treeActions.openChat,
            worker: openWorker,
            access: review,
            connector: showSettings
          }}
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
          treeActions={deleteChat ? { ...props.treeActions, deleteChat } : props.treeActions}
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
        needsYouOnly={filter.needsYou}
        onNeedsYouOnly={() => changeFilter({ ...filter, needsYou: !filter.needsYou })}
        onSettings={() => showSettings(undefined)}
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
  const shownItem = page?.startsWith('item:') ? walk.shown(page.slice('item:'.length)) : null
  const pageNode =
    page === 'settings' ? (
      <View style={styles.page}>
        <ScrollView
          ref={settingsScroll}
          style={styles.scroll}
          showsVerticalScrollIndicator={false}
          // A search page's first tap on a result selects it, not just closes the keyboard.
          keyboardShouldPersistTaps="handled"
        >
          <SheetPageScrollContext.Provider value={settingsScroll}>
            <MobileBotSettingsTab
              key={settings.opens}
              initialPage={settings.at}
              onBack={{
                label: t('bots.panel.backTo', 'Back to {{name}}', { name: bot.name }),
                onPress: pager.close
              }}
              routeBot={props.routeBot}
              client={props.client}
              showToast={showToast}
              online={props.online}
              hostName={props.hostName}
              home={props.home}
              accessRequests={props.accessRequests}
              onAskInChat={props.onStartSuggestion}
              onOpenFile={(path) => props.onOpenFile(path, showToast)}
              upNext={upNext}
            />
          </SheetPageScrollContext.Provider>
        </ScrollView>
      </View>
    ) : page?.startsWith('automation:') ? (
      automations.page(page.slice('automation:'.length))
    ) : shownItem ? (
      <MobileBotItemPage
        key={shownItem.uid}
        {...shownItem}
        client={props.client}
        hostKey={props.hostKey}
        hostId={props.hostId}
        bot={bot}
        showToast={showToast}
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
          <TransientToast message={message} bottomInset={shownItem ? boxHeight : -spacing.lg} />
        </View>
      </BottomDrawer>
      <MobileBotItemSheets
        sheet={sheet}
        setSheet={setSheet}
        online={props.online}
        hostName={props.hostName}
        onSelect={tab === 'items' && !shownItem ? (item) => setSelected(new Set([item.uid])) : null}
        onOpenChat={props.onOpenItemChat}
        move={async (moved, to, reason) => clearOnWrite(await moves.move(moved, to, reason))}
        snooze={async (snoozed, until) => clearOnWrite(await moves.snooze(snoozed, until))}
      />
      {accessSheet}
      {automations.sheets}
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
