// A group's Items: every member's asks and items in one list, scoped to the group's rooms, each row
// naming its bot, as the desktop's group Home panel shows them. A row opens that bot's item in place,
// stepping through the list as shown; the filter (a page here, as the drawer takes no sheet over it)
// picks bots, a room or all their work.
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { ScrollView, Text, View } from 'react-native'
import { Inbox, ListFilter } from 'lucide-react-native'
import { BOT_ITEM_GROUP_IDS, type BotItemGroupId } from '../../../src/shared/bots/bot-item-groups'
import type { BotItem } from '../../../src/shared/bots/bot-items'
import { botItemWalkOf } from '../../../src/shared/bots/bot-item-walk'
import { BottomDrawer, OptionPager, useOptionPager } from '../components/bottom-drawer/BottomDrawer'
import { BottomDrawerModalHost } from '../components/bottom-drawer/bottom-drawer-modal-host'
import { TransientToast, useTransientToast } from '../components/feedback/TransientToast'
import {
  MobileLoadErrorState,
  MobileNoMatchState,
  MobileOfflineState,
  MobileStateView
} from '../components/feedback/MobileStateView'
import { NavBarButton } from '../components/nav-bar/NavBarButton'
import { SheetHeader } from '../components/nav-bar/SheetHeader'
import { useNow } from '../hooks/use-now'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useRouteHandoff } from '../navigation/route-handoff'
import { colors, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { botHomeWorktreeId, hostBotsKey } from './host-bots-read'
import type { PhoneBot } from './host-bots-operations'
import { mobileBotAvatarSource } from './host-bot-row-facts'
import { openBotItemFile } from './items/bot-item-file-open'
import { MobileBotItemPage } from './items/MobileBotItemPage'
import { MobileBotGroupItemsAllClear } from './items/MobileBotItemsAllClear'
import { MobileBotItemRow } from './items/MobileBotItemRow'
import { MobileBotItemSheets, type BotItemSheet } from './items/MobileBotItemSheets'
import { ItemGroup, ReadFailed } from './items/MobileBotItemsTab'
import { MobileBotNeedsYouGroup } from './items/MobileBotNeedsYouGroup'
import { openPhoneAsk } from './items/phone-needs-you-asks'
import { useBotItemMoves } from './items/use-bot-item-moves'
import { usePhoneBotItemWalk } from './items/use-phone-bot-item-walk'
import { MobileBotGroupItemsFilter } from './MobileBotGroupItemsFilter'
import { useMobileBotGroupItemOpeners } from './use-mobile-bot-group-item-openers'
import {
  memberItemReads,
  useMobileBotGroupItems,
  type BotGroupItemsScope
} from './use-mobile-bot-group-items'
import type { BotGroupItemReads } from './use-mobile-bot-group-transcript'

type Translate = ReturnType<typeof useMobileTranslation>
type Page = 'filter' | `item:${string}`

/** "Ana", "Ana or Bo", "Ana, Bo or Cy". */
function botNames(bots: readonly PhoneBot[], t: Translate): string {
  const names = bots.map((bot) => bot.name)
  const last = names.pop()
  return names.length === 0
    ? (last ?? '')
    : t('bots.groups.items.orNames', '{{names}} or {{last}}', { names: names.join(', '), last })
}

function outsideLine(kind: BotGroupItemsScope['kind'], count: number, t: Translate): string {
  return kind === 'room'
    ? t('bots.groups.items.outsideRoom', '{{count}} more outside this room', { count })
    : kind === 'thread'
      ? t('bots.groups.items.outsideThread', '{{count}} more outside this thread', { count })
      : t('bots.groups.items.outside', '{{count}} more outside this group', { count })
}

export function MobileBotGroupItems({
  visible,
  onClose,
  client,
  groupId,
  hostId,
  bots,
  needsYou,
  reads,
  memberIds,
  online,
  hostName,
  onOpenRoom
}: {
  visible: boolean
  onClose: () => void
  client: RpcClient | null
  groupId: string
  hostId: string
  /** The computer's bots, as the room read them. */
  bots: readonly PhoneBot[]
  /** Each bot's Needs you items that aren't stale, from the bot list. */
  needsYou: Readonly<Record<string, number>>
  reads: BotGroupItemReads
  memberIds: RefObject<readonly string[]>
  online: boolean
  hostName: string
  /** Opens one of the group's rooms: the original's (undefined) or a thread's. */
  onOpenRoom: (threadId: string | undefined) => void
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const router = useRouteHandoff()
  const pager = useOptionPager<Page>()
  // Each open lands on the list, as the bot panel's does.
  const { forget } = pager
  useEffect(() => {
    if (visible) {
      forget()
    }
  }, [visible, forget])
  // A worker lookup that answers after the drawer closed, or its item was left, opens nothing.
  const showing = useRef<{ visible: boolean; item: string | null }>({ visible, item: null })
  const { message, showToast } = useTransientToast()
  const [sheet, setSheet] = useState<BotItemSheet | null>(null)
  const [boxHeight, setBoxHeight] = useState(0)
  const now = useNow(60_000, visible)
  const moves = useBotItemMoves({ client, hostName, showToast })
  // Through the rows as shown: a member's Closed pages aren't read past what the list has.
  const walk = usePhoneBotItemWalk({
    items: { loadMoreClosed: null, closedEnded: true },
    pager,
    showToast,
    opened: visible
  })

  const read = useMobileBotGroupItems({
    visible,
    client,
    groupId,
    bots,
    needsYou,
    reads,
    memberIds,
    now,
    t
  })
  const {
    group,
    members,
    scope,
    needsYouOnly,
    groups,
    ownerOf,
    asks,
    isUnseen,
    allRead,
    failed,
    outside,
    filterOn,
    clearFilter,
    closedTotal,
    moreClosed,
    retry
  } = read
  const working = groups.working.length
  const needsYouShown = groups.needs_you.length + asks.length

  const open = useMobileBotGroupItemOpeners({
    client,
    hostId,
    group,
    onClose,
    onOpenRoom,
    showToast
  })
  const openChat = (item: BotItem) =>
    open.chat(ownerOf.get(item.uid), item.chat.id, item.chat.kind === 'home')
  const askBots = new Map(asks.map(({ ask, bot }) => [ask.key, bot]))

  let body: ReactNode
  if (!online) {
    body = <MobileOfflineState hostName={hostName} />
  } else if (!allRead) {
    body = failed ? (
      <MobileLoadErrorState
        error={read.error}
        title={t('bots.items.readFailedTitle', 'Couldn’t load items')}
        onRetry={retry}
      />
    ) : (
      <MobileStateView loading title={t('bots.items.loading', 'Loading items…')} />
    )
  } else if (
    asks.length === 0 &&
    BOT_ITEM_GROUP_IDS.every((id) => groups[id].length === 0) &&
    closedTotal === 0
  ) {
    body = filterOn ? (
      <MobileNoMatchState
        message={
          needsYouOnly
            ? t('bots.items.empty.needsYou', 'Nothing needs you.')
            : t('bots.items.empty.filtered', 'No items match.')
        }
        onClear={clearFilter}
        clearLabel={t('bots.items.filter.clearAll', 'Clear filters')}
      />
    ) : (
      <MobileStateView
        icon={Inbox}
        title={t('bots.groups.items.emptyTitle', 'No items from this group yet')}
        message={t(
          'bots.groups.items.emptyBody',
          'When {{names}} take something on in this group, it shows up here.',
          { names: botNames(members, t) }
        )}
      />
    )
  } else {
    const row = (item: BotItem, id: BotItemGroupId) => {
      const owner = ownerOf.get(item.uid)
      return (
        <MobileBotItemRow
          key={item.uid}
          item={item}
          stale={id === 'stale'}
          snoozed={id === 'snoozed'}
          unseen={isUnseen(item)}
          checked={null}
          now={now}
          disabled={failed}
          owner={owner ? { name: owner.name, avatar: mobileBotAvatarSource(owner) } : undefined}
          onPress={() => walk.open(item, botItemWalkOf(groups, groups.closed.length))}
          onLongPress={() => setSheet({ kind: 'row', item })}
        />
      )
    }
    // Offline and work outside the scope say so elsewhere, as on the desktop.
    const allClear =
      !filterOn &&
      asks.length === 0 &&
      outside === 0 &&
      BOT_ITEM_GROUP_IDS.some((id) => groups[id].length > 0) &&
      groups.needs_you.length + working === 0
    body = (
      <>
        {allClear ? <MobileBotGroupItemsAllClear members={members} /> : null}
        {BOT_ITEM_GROUP_IDS.map((id) =>
          id === 'needs_you' ? (
            <MobileBotNeedsYouGroup
              key={id}
              botName={group?.name ?? ''}
              asks={asks.map(({ ask }) => ask)}
              ownerOf={(ask) => {
                const bot = askBots.get(ask.key)
                return bot ? { name: bot.name, avatar: mobileBotAvatarSource(bot) } : undefined
              }}
              items={groups.needs_you}
              disabled={failed}
              renderItem={(item) => row(item, id)}
              onOpenAsk={(ask) => {
                const bot = askBots.get(ask.key)
                openPhoneAsk(ask, {
                  chat: (chat) => open.chat(bot, chat.chatId, chat.origin === 'home'),
                  // Opening an item or closing the drawer meanwhile drops a late lookup.
                  worker: (worker) =>
                    open.worker(
                      worker,
                      () => showing.current.visible && showing.current.item === null
                    ),
                  // The group lists no access requests.
                  access: () => {}
                })
              }}
              client={client}
              onSkipFailed={showToast}
            />
          ) : (
            <ItemGroup
              key={id}
              id={id}
              items={groups[id]}
              total={
                id === 'closed' ? Math.max(closedTotal, groups.closed.length) : groups[id].length
              }
              onMoreClosed={
                id === 'closed' && !needsYouOnly && moreClosed.length > 0
                  ? async () => {
                      await Promise.all(moreClosed.map((more) => more()))
                    }
                  : null
              }
              isUnseen={isUnseen}
              renderItem={(item) => row(item, id)}
              onCancelAll={null}
            />
          )
        )}
      </>
    )
  }

  const summary = [
    needsYouShown > 0
      ? t('bots.groups.items.needsYouCount', '{{count}} needs you', { count: needsYouShown })
      : null,
    working > 0
      ? t('bots.groups.items.workingCount', '{{count}} working', { count: working })
      : null
  ]
    .filter(Boolean)
    .join(' · ')

  const main = (
    <View style={styles.root}>
      <SheetHeader
        title={group?.name ?? t('bots.groups.group', 'Group')}
        {...(summary ? { subtitle: summary } : {})}
        trailingButtons={
          <NavBarButton
            icon={ListFilter}
            accessibilityLabel={t('bots.items.filter.label', 'Filter items')}
            active={filterOn}
            onPress={() => pager.open('filter')}
          />
        }
      />
      <ScrollView
        style={styles.root}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {allRead && failed && online ? <ReadFailed onRetry={retry} /> : null}
        {body}
        {/* Under an empty scoped list too: that is where outside work matters most. */}
        {allRead && outside > 0 && scope ? (
          <Text style={styles.outside}>{outsideLine(scope.kind, outside, t)}</Text>
        ) : null}
      </ScrollView>
    </View>
  )

  const page = pager.page
  const shownItem = page?.startsWith('item:') ? walk.shown(page.slice('item:'.length)) : null
  const itemUid = shownItem?.uid ?? null
  const itemBot = itemUid ? ownerOf.get(itemUid) : undefined
  useEffect(() => {
    showing.current = { visible, item: itemUid }
  }, [visible, itemUid])
  const pageNode =
    page === 'filter' ? (
      <MobileBotGroupItemsFilter read={read} onDone={pager.close} />
    ) : shownItem && itemBot ? (
      <MobileBotItemPage
        key={shownItem.uid}
        {...shownItem}
        client={client}
        hostKey={hostBotsKey(hostId)}
        hostId={hostId}
        bot={itemBot}
        showToast={showToast}
        reads={memberItemReads(reads, itemBot.id)}
        online={online}
        hostName={hostName}
        onBack={pager.close}
        setSheet={setSheet}
        onOpenChat={openChat}
        onOpenWorker={(worker) => {
          const from = itemUid
          open.worker(worker, () => showing.current.visible && showing.current.item === from)
        }}
        onOpenFile={(path) =>
          openBotItemFile({
            path,
            router,
            hostId,
            worktreeId: botHomeWorktreeId(itemBot),
            t,
            toast: showToast,
            onRequestClose: onClose
          })
        }
        onCommentBoxHeight={setBoxHeight}
      />
    ) : null

  return (
    <>
      {/* Outside the drawer and its modal host, which remount their children: the last reads stay. */}
      {read.readers}
      <BottomDrawerModalHost>
        <BottomDrawer
          visible={visible}
          onClose={onClose}
          fillAvailable
          contentScrollable={false}
          dragContentToDismiss={false}
        >
          <View style={styles.root}>
            <OptionPager pager={pager} main={main} page={pageNode} fill />
            <TransientToast message={message} bottomInset={itemUid ? boxHeight : -spacing.lg} />
          </View>
        </BottomDrawer>
        <MobileBotItemSheets
          sheet={sheet}
          setSheet={setSheet}
          online={online}
          hostName={hostName}
          onSelect={null}
          onOpenChat={openChat}
          move={(moved, to, reason) => moves.move(moved, to, reason)}
          snooze={(snoozed, until) => moves.snooze(snoozed, until)}
        />
      </BottomDrawerModalHost>
    </>
  )
}
const styles = themedStyleSheet(() => ({
  root: { flex: 1 },
  scrollContent: { paddingBottom: spacing.lg },
  outside: {
    textAlign: 'center',
    fontSize: typography.metaSize,
    color: colors.textMuted,
    paddingVertical: spacing.md
  }
}))
