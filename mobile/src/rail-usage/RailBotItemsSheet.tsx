import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ScrollView, View } from 'react-native'
import { Inbox, ListFilter } from 'lucide-react-native'
import { BOT_ITEM_GROUP_IDS, type BotItemGroupId } from '../../../src/shared/bots/bot-item-groups'
import type { BotItem } from '../../../src/shared/bots/bot-items'
import { botItemWalkOf } from '../../../src/shared/bots/bot-item-walk'
import { botHomeWorktreeId } from '../bots/host-bots-read'
import { mobileBotAvatarSource } from '../bots/host-bot-row-facts'
import { openBotItemFile } from '../bots/items/bot-item-file-open'
import { MobileBotItemPage } from '../bots/items/MobileBotItemPage'
import { MobileBotItemRow } from '../bots/items/MobileBotItemRow'
import type { BotItemSheet } from '../bots/items/MobileBotItemSheets'
import {
  MobileBotGroupItemsAllClear,
  MobileBotItemsAllClear
} from '../bots/items/MobileBotItemsAllClear'
import { ItemGroup, ReadFailed } from '../bots/items/MobileBotItemsTab'
import { MobileBotNeedsYouGroup } from '../bots/items/MobileBotNeedsYouGroup'
import { openPhoneAsk } from '../bots/items/phone-needs-you-asks'
import { usePhoneBotItemWalk } from '../bots/items/use-phone-bot-item-walk'
import { BottomDrawer, OptionPager, useOptionPager } from '../components/bottom-drawer/BottomDrawer'
import { BottomDrawerModalHost } from '../components/bottom-drawer/bottom-drawer-modal-host'
import {
  MobileLoadErrorState,
  MobileNoMatchState,
  MobileOfflineState,
  MobileStateView
} from '../components/feedback/MobileStateView'
import { TransientToast, useTransientToast } from '../components/feedback/TransientToast'
import { NavBarButton } from '../components/nav-bar/NavBarButton'
import { SheetHeader } from '../components/nav-bar/SheetHeader'
import { useNow } from '../hooks/use-now'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useRouteHandoff } from '../navigation/route-handoff'
import { spacing } from '../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../theme/themed-styles'
import { RailBotItemsFilter } from './RailBotItemsFilter'
import { TargetHostGatesProvider, TargetItemSheetsHost } from './RailBotItemTargetHost'
import { useRailBotItemOpeners } from './rail-bot-item-openers'
import type { RailBotsSource } from './rail-bot-targets'
import { useRailBotItems } from './use-rail-bot-items'

type SheetPage = 'filter' | `item:${string}`

/** Combined bots Items drawer opened from the side rail: works from Home, any host screen, or a chat. */
export function RailBotItemsSheet({
  visible,
  onClose,
  bots
}: {
  visible: boolean
  onClose: () => void
  bots: RailBotsSource
}): React.JSX.Element {
  const styles = useThemedStyles(stylesSheet)
  const t = useMobileTranslation()
  const router = useRouteHandoff()
  const pager = useOptionPager<SheetPage>()
  const { forget } = pager
  const { message, showToast } = useTransientToast()
  const [sheet, setSheet] = useState<BotItemSheet | null>(null)
  const [boxHeight, setBoxHeight] = useState(0)
  const now = useNow(60_000, visible)
  const showingRef = useRef<{ visible: boolean; item: string | null }>({ visible, item: null })
  const openers = useRailBotItemOpeners({ onClose, showToast })

  useEffect(() => {
    if (visible) {
      forget()
    }
  }, [visible, forget])

  const read = useRailBotItems({ visible, targets: bots.targets, now })
  const {
    reads,
    targets,
    shownTargets,
    pickedKeys,
    setPickedKeys,
    needsYouOnly,
    setNeedsYouOnly,
    showHostNames,
    groups,
    ownerOf,
    asks,
    isUnseen,
    allRead,
    failed,
    error,
    filterOn,
    clearFilter,
    closedTotal,
    moreClosed,
    retry,
    openCount,
    readers
  } = read

  const walk = usePhoneBotItemWalk({
    items: { loadMoreClosed: null, closedEnded: true },
    pager,
    showToast,
    opened: visible
  })

  const openChat = (item: BotItem): void =>
    openers.openChat(ownerOf.get(item.uid), item.chat.id, item.chat.kind === 'home')

  const showOwners = targets.length > 1
  const askTargets = new Map(asks.map(({ ask, target }) => [ask.key, target]))
  const working = groups.working.length
  const needsYouShown = groups.needs_you.length + asks.length

  let body: ReactNode
  if (!bots.online && targets.length === 0) {
    body = <MobileOfflineState hostName={bots.hostName} />
  } else if (bots.loading) {
    body = <MobileStateView loading title={t('bots.items.loading', 'Loading items…')} />
  } else if (targets.length === 0) {
    body = (
      <MobileStateView
        icon={Inbox}
        title={t('bots.items.empty.title', 'No items yet')}
        message={t('bots.list.noBotsYet', 'No bots yet.')}
      />
    )
  } else if (!allRead) {
    body = failed ? (
      <MobileLoadErrorState
        error={error}
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
      <MobileStateView icon={Inbox} title={t('bots.items.empty.title', 'No items yet')} />
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
          owner={
            showOwners && owner
              ? { name: owner.bot.name, avatar: mobileBotAvatarSource(owner.bot) }
              : undefined
          }
          onPress={() => walk.open(item, botItemWalkOf(groups, groups.closed.length, item.uid))}
          onLongPress={() => setSheet({ kind: 'row', item })}
        />
      )
    }
    const allClear =
      !filterOn &&
      asks.length === 0 &&
      BOT_ITEM_GROUP_IDS.some((id) => groups[id].length > 0) &&
      groups.needs_you.length + working === 0
    body = (
      <>
        {allClear ? (
          shownTargets.length > 1 ? (
            <MobileBotGroupItemsAllClear members={shownTargets.map((target) => target.bot)} />
          ) : (
            <MobileBotItemsAllClear />
          )
        ) : null}
        {BOT_ITEM_GROUP_IDS.map((id) =>
          id === 'needs_you' ? (
            <MobileBotNeedsYouGroup
              key={id}
              botName={shownTargets.length === 1 ? shownTargets[0]!.bot.name : ''}
              asks={asks.map(({ ask }) => ask)}
              ownerOf={(ask) => {
                if (!showOwners) {
                  return undefined
                }
                const target = askTargets.get(ask.key)
                return target
                  ? { name: target.bot.name, avatar: mobileBotAvatarSource(target.bot) }
                  : undefined
              }}
              items={groups.needs_you}
              now={now}
              disabled={failed}
              renderItem={(item) => row(item, id)}
              onOpenAsk={(ask) => {
                const target = askTargets.get(ask.key)
                openPhoneAsk(ask, {
                  chat: (chat) => openers.openChat(target, chat.chatId, chat.origin === 'home'),
                  worker: (worker) =>
                    openers.openWorker(
                      target,
                      worker,
                      () => showingRef.current.visible && showingRef.current.item === null
                    ),
                  access: () => {}
                })
              }}
              client={shownTargets[0]?.client ?? null}
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
    <View style={styles.root} testID="rail-bot-items-sheet">
      <SheetHeader
        title={t('bots.items.tab', 'Items')}
        {...(summary ? { subtitle: summary } : {})}
        trailingButtons={
          targets.length > 0 ? (
            <NavBarButton
              icon={ListFilter}
              accessibilityLabel={t('bots.items.filter.label', 'Filter items')}
              active={filterOn}
              onPress={() => pager.open('filter')}
            />
          ) : undefined
        }
      />
      <ScrollView
        style={styles.root}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {allRead && failed && bots.online ? <ReadFailed onRetry={retry} /> : null}
        {body}
      </ScrollView>
    </View>
  )

  const page = pager.page
  const shownItem = page?.startsWith('item:') ? walk.shown(page.slice('item:'.length)) : null
  const itemUid = shownItem?.uid ?? null
  const itemTarget = itemUid ? (ownerOf.get(itemUid) ?? null) : null

  useEffect(() => {
    showingRef.current = { visible, item: itemUid }
  }, [visible, itemUid])

  const sheetItemUid =
    sheet === null ? null : 'item' in sheet ? sheet.item.uid : (sheet.items[0]?.uid ?? null)
  const sheetTarget =
    (sheetItemUid ? ownerOf.get(sheetItemUid) : null) ?? itemTarget ?? targets[0] ?? null

  const pageNode =
    page === 'filter' ? (
      <RailBotItemsFilter
        targets={targets}
        pickedKeys={pickedKeys}
        setPickedKeys={setPickedKeys}
        needsYouOnly={needsYouOnly}
        setNeedsYouOnly={setNeedsYouOnly}
        openCount={openCount}
        showHostNames={showHostNames}
        onClear={clearFilter}
        onDone={pager.close}
      />
    ) : shownItem && itemTarget ? (
      <TargetHostGatesProvider target={itemTarget}>
        <MobileBotItemPage
          key={shownItem.uid}
          {...shownItem}
          client={itemTarget.client}
          hostKey={itemTarget.hostKey}
          hostId={itemTarget.pairedHostId}
          bot={itemTarget.bot}
          showToast={showToast}
          reads={reads}
          online={itemTarget.online}
          hostName={itemTarget.hostName}
          onBack={pager.close}
          setSheet={setSheet}
          onOpenChat={openChat}
          onOpenWorker={(worker) => {
            const from = itemUid
            openers.openWorker(
              itemTarget,
              worker,
              () => showingRef.current.visible && showingRef.current.item === from
            )
          }}
          onOpenFile={(path) =>
            openBotItemFile({
              path,
              router,
              hostId: itemTarget.pairedHostId,
              worktreeId: botHomeWorktreeId(itemTarget.bot),
              t,
              toast: showToast,
              onRequestClose: onClose
            })
          }
          onCommentBoxHeight={setBoxHeight}
        />
      </TargetHostGatesProvider>
    ) : null

  return (
    <>
      {/* Outside the drawer and its modal host, which remount their children: the last reads stay. */}
      {readers}
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
        <TargetHostGatesProvider target={sheetTarget}>
          <TargetItemSheetsHost
            target={sheetTarget}
            sheet={sheet}
            setSheet={setSheet}
            onOpenChat={openChat}
            showToast={showToast}
          />
        </TargetHostGatesProvider>
      </BottomDrawerModalHost>
    </>
  )
}

const stylesSheet = themedStyleSheet(() => ({
  root: { flex: 1 },
  scrollContent: { paddingBottom: spacing.lg }
}))
