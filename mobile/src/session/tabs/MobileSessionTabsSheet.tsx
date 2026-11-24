import { Fragment, useMemo, useRef, useState, type ReactNode } from 'react'
import { MobileForkMarkedName } from '../fork/MobileForkMarkedName'
import { mobileForkAccessibleName } from '../fork/mobile-fork-marked-name'
import { Pressable, Text, View } from 'react-native'
import { Bell, Check, Columns2, CornerDownRight, Plus, X } from 'lucide-react-native'
import { BottomDrawer } from '../../components/bottom-drawer/BottomDrawer'
import { ListGroup, SectionHeader } from '../../components/list/ListGroup'
import { TailClippedText } from '../../components/list/TailClippedText'
import { NavBarButton } from '../../components/nav-bar/NavBarButton'
import { SheetHeader } from '../../components/nav-bar/SheetHeader'
import { SwipeRowActions } from '../../components/list/SwipeRowActions'
import { AgentStateDot } from '../../agents/presentation/AgentStateDot'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useNow } from '../../hooks/use-now'
import { formatTimeAgo, type AgentDotState } from '../../worktree/agent-lineage/agent-row-display'
import { colors, radii, spacing } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import {
  buildMobileSessionTabRow,
  groupMobileSessionSplitTabs,
  isForkedChatTab,
  type MobileSessionTabEntry,
  type MobileSessionTabGroup,
  type MobileSessionTabRow,
  type MobileSessionTabSummary
} from './mobile-session-tab-rows'
import { MobileSessionTabMark } from './MobileSessionTabMark'
import type { MobileSessionController } from '../use-mobile-session-controller'

const TILE_SIZE = 34
const TILE_DOT_RING = 2
const GROUP_ORDER: readonly MobileSessionTabGroup[] = ['needs-you', 'working', 'other']

type Entry = MobileSessionTabEntry<MobileSessionTabRow>

const entryGroup = (entry: Entry): MobileSessionTabGroup =>
  entry.kind === 'tab' ? entry.tab.group : entry.group

/** Every tab in the workspace, what needs you first; tap one to go there, swipe one to close it. */
export function MobileSessionTabsSheet({
  controller,
  tabs,
  visible,
  onClose
}: {
  controller: MobileSessionController
  tabs: readonly MobileSessionTabSummary[]
  visible: boolean
  onClose: () => void
}) {
  const afterCloseRef = useRef<(() => void) | null>(null)
  // Why: the drawer draws its content only while shown, so a closed sheet runs no clock and builds no rows (STA-15103).
  return (
    <BottomDrawer
      visible={visible}
      onClose={onClose}
      onAfterClose={() => {
        const afterClose = afterCloseRef.current
        afterCloseRef.current = null
        afterClose?.()
      }}
    >
      <MobileSessionTabsSheetContent
        controller={controller}
        tabs={tabs}
        onClose={onClose}
        onOpenNewTab={() => {
          // The new-tab sheet is its own drawer; open it once this one is gone.
          afterCloseRef.current = controller.handleOpenNewTab
          onClose()
        }}
      />
    </BottomDrawer>
  )
}

function MobileSessionTabsSheetContent({
  controller,
  tabs,
  onClose,
  onOpenNewTab
}: {
  controller: MobileSessionController
  tabs: readonly MobileSessionTabSummary[]
  onClose: () => void
  onOpenNewTab: () => void
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const now = useNow(60_000)
  const {
    activeSessionTabId,
    worktreeName,
    switchSessionTab,
    handleCloseSessionTab,
    createTabBusy,
    connState
  } = controller
  const rows = useMemo(() => tabs.map((tab) => buildMobileSessionTabRow(tab)), [tabs])
  const entries = useMemo(() => groupMobileSessionSplitTabs(rows), [rows])
  // Sections hold still while the sheet is shown (closing included), so a row never moves under a finger.
  const [frozenGroups] = useState<ReadonlyMap<string, MobileSessionTabGroup>>(
    () => new Map(entries.map((entry) => [entry.key, entryGroup(entry)]))
  )
  const sections = GROUP_ORDER.map((group) => ({
    group,
    entries: entries.filter((entry) => (frozenGroups.get(entry.key) ?? entryGroup(entry)) === group)
  })).filter((section) => section.entries.length > 0)
  const sectionTitles: Record<MobileSessionTabGroup, string> = {
    'needs-you': t('session.tabsSheet.needsYou', 'Needs you'),
    working: t('session.tabsSheet.working', 'Working'),
    other: t('session.tabsSheet.everythingElse', 'Everything else')
  }
  const title =
    entries.length === 1
      ? t('session.tabBar.oneTab', '1 tab')
      : t('session.tabBar.tabCount', '{{count}} tabs', { count: entries.length })
  const open = (tab: MobileSessionTabSummary['tab']) => {
    if (tab.id !== activeSessionTabId) {
      switchSessionTab(tab)
    }
    onClose()
  }

  // Closing every pane closes the desktop tab, on hosts old and new.
  const closePanes = async (panes: readonly MobileSessionTabRow[]) => {
    for (const pane of panes) {
      await handleCloseSessionTab(pane.tab)
    }
  }

  const renderTab = (row: MobileSessionTabRow) => {
    const current = row.tab.id === activeSessionTabId
    const time = row.timeAt !== null ? formatTimeAgo(row.timeAt, now) : ''
    return (
      <SheetRow
        key={row.tab.id}
        title={row.title}
        accessibilityLabel={[
          isForkedChatTab(row.tab) ? mobileForkAccessibleName(row.title) : row.title,
          row.stateWord,
          row.content,
          row.unread ? t('agents.list.unread', 'Unread') : null,
          time
        ]
          .filter(Boolean)
          .join(', ')}
        current={current}
        onPress={() => open(row.tab)}
        onSwipeClose={() => void handleCloseSessionTab(row.tab)}
      >
        <Tile
          badge={row.dotState}
          unreadBell={row.unread && row.group === 'other'}
          mark={<MobileSessionTabMark row={row} size={17} />}
        />
        <View style={styles.text}>
          <Text style={styles.title} numberOfLines={1}>
            {isForkedChatTab(row.tab) ? <MobileForkMarkedName name={row.title} /> : row.title}
          </Text>
          <RowDetail row={row} />
        </View>
        {time ? <Text style={styles.time}>{time}</Text> : null}
        {current ? <CurrentCheck /> : null}
      </SheetRow>
    )
  }

  const renderSplit = (entry: Extract<Entry, { kind: 'split' }>) => {
    const { panes } = entry
    const splitTitle = panes[0].title
    const paneCount =
      panes.length === 1
        ? t('session.tabsSheet.panes_one', '{{count}} pane', { count: panes.length })
        : t('session.tabsSheet.panes_other', '{{count}} panes', { count: panes.length })
    const target =
      panes.find((pane) => pane.tab.id === activeSessionTabId) ??
      panes.find((pane) => pane.tab.isActive) ??
      panes[0]
    return [
      <SheetRow
        key={`split:${entry.key}`}
        title={splitTitle}
        accessibilityLabel={[
          splitTitle,
          paneCount,
          entry.unread ? t('agents.list.unread', 'Unread') : null
        ]
          .filter(Boolean)
          .join(', ')}
        current={false}
        onPress={() => open(target.tab)}
        onSwipeClose={() => void closePanes(panes)}
      >
        <Tile
          badge={entry.dotState}
          unreadBell={entry.unread && entry.group === 'other'}
          mark={<Columns2 size={17} color={colors.textSecondary} strokeWidth={2.1} />}
        />
        <View style={styles.text}>
          <Text style={styles.title} numberOfLines={1}>
            {splitTitle}
          </Text>
          <Text style={styles.detail} numberOfLines={1}>
            {paneCount}
          </Text>
        </View>
      </SheetRow>,
      ...panes.map((row) => {
        const current = row.tab.id === activeSessionTabId
        return (
          <SheetRow
            key={row.tab.id}
            title={row.title}
            accessibilityLabel={[row.title, row.stateWord, row.content].filter(Boolean).join(', ')}
            current={current}
            pane
            onPress={() => open(row.tab)}
            onSwipeClose={() => void handleCloseSessionTab(row.tab)}
          >
            <View style={styles.paneMark}>
              <CornerDownRight size={14} color={colors.textMuted} strokeWidth={2} />
            </View>
            <View style={styles.text}>
              <Text style={styles.paneTitle} numberOfLines={1}>
                {row.title}
              </Text>
              <RowDetail row={row} />
            </View>
            {current ? <CurrentCheck /> : null}
          </SheetRow>
        )
      })
    ]
  }

  return (
    <>
      <SheetHeader
        title={title}
        subtitle={worktreeName || undefined}
        trailingButtons={
          <NavBarButton
            icon={Plus}
            disabled={createTabBusy || connState !== 'connected'}
            accessibilityLabel={t('session.tabStrip.newTab', 'New tab')}
            onPress={onOpenNewTab}
          />
        }
      />
      <View style={styles.body}>
        {sections.map((section, index) => (
          <Fragment key={section.group}>
            {sections.length > 1 ? (
              <SectionHeader title={sectionTitles[section.group]} first={index === 0} />
            ) : null}
            <ListGroup separatorInset={spacing.lg + TILE_SIZE + spacing.md}>
              {section.entries.flatMap((entry) =>
                entry.kind === 'tab' ? [renderTab(entry.tab)] : renderSplit(entry)
              )}
            </ListGroup>
          </Fragment>
        ))}
      </View>
    </>
  )
}

function SheetRow({
  title,
  accessibilityLabel,
  current,
  pane = false,
  onPress,
  onSwipeClose,
  children
}: {
  title: string
  accessibilityLabel: string
  current: boolean
  /** A split's pane, indented under its tab. */
  pane?: boolean
  onPress: () => void
  onSwipeClose: () => void
  children: ReactNode
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  return (
    <SwipeRowActions
      trailing={{
        label: t('common.close', 'Close'),
        accessibilityLabel: t('session.tabsSheet.closeTab', 'Close {{title}}', { title }),
        icon: X,
        background: colors.statusRed,
        foreground: colors.onStatusRed,
        onPress: onSwipeClose
      }}
    >
      {(guardPress) => (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel}
          accessibilityState={{ selected: current }}
          style={[styles.row, pane && styles.paneRow]}
          onPress={guardPress(onPress)}
        >
          {({ pressed }) => (
            <>
              {pressed ? <View pointerEvents="none" style={styles.wash} /> : null}
              {children}
            </>
          )}
        </Pressable>
      )}
    </SwipeRowActions>
  )
}

function Tile({
  mark,
  badge,
  unreadBell
}: {
  mark: ReactNode
  badge: AgentDotState | undefined
  unreadBell: boolean
}) {
  const dot = badge && badge !== 'idle' ? badge : undefined
  return (
    <View style={styles.tile}>
      {mark}
      {unreadBell || dot ? (
        <View style={styles.tileBadge}>
          {unreadBell ? (
            <Bell size={10} color={colors.statusAmber} fill={colors.statusAmber} />
          ) : dot ? (
            <AgentStateDot state={dot} />
          ) : null}
        </View>
      ) : null}
    </View>
  )
}

// The second line only when it adds to the title; paths and URLs keep their end in view.
function RowDetail({ row }: { row: MobileSessionTabRow }) {
  if (!row.stateWord && !row.content) {
    return null
  }
  if (!row.stateWord && row.tab.type !== 'terminal' && row.tab.type !== 'agent-session') {
    return <TailClippedText style={styles.detail}>{row.content}</TailClippedText>
  }
  return (
    <Text style={styles.detail} numberOfLines={1}>
      {row.stateWord ? (
        <Text style={row.group === 'needs-you' ? styles.stateNeedsYou : undefined}>
          {row.stateWord}
        </Text>
      ) : null}
      {row.stateWord && row.content ? ' · ' : ''}
      {row.content}
    </Text>
  )
}

function CurrentCheck() {
  return <Check size={18} color={colors.accentBlue} strokeWidth={2.6} />
}

const styles = themedStyleSheet(() => ({
  body: { paddingBottom: spacing.lg },
  // Opaque so a swipe's action stays hidden until the row slides off it.
  row: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    backgroundColor: colors.sheetGroup
  },
  // Indented under its tab's tile, so the corner arrow points into the split.
  paneRow: { minHeight: 44, paddingLeft: 34, gap: 10, paddingVertical: 6 },
  // A pressed row, washed like a picked segment on a sheet group.
  wash: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: colors.translucentFill
  },
  tile: {
    width: TILE_SIZE,
    height: TILE_SIZE,
    borderRadius: radii.tile,
    backgroundColor: colors.translucentFill,
    alignItems: 'center',
    justifyContent: 'center'
  },
  // The state dot on the tile's corner, ringed in the group's colour.
  tileBadge: {
    position: 'absolute',
    top: -4,
    right: -4,
    padding: TILE_DOT_RING,
    borderRadius: radii.pill,
    backgroundColor: colors.sheetGroup
  },
  paneMark: { width: 24, alignItems: 'center' },
  text: { flex: 1, minWidth: 0, gap: 1 },
  title: { fontSize: 15, fontWeight: '500', color: colors.textPrimary },
  paneTitle: { fontSize: 14, color: colors.textPrimary },
  detail: { fontSize: 13, color: colors.textSecondary },
  stateNeedsYou: { color: colors.agentQuestionText },
  time: { fontSize: 12, color: colors.textMuted, fontVariant: ['tabular-nums'] }
}))
