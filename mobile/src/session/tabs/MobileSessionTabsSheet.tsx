import { Fragment, useMemo, useRef, useState, type ReactNode } from 'react'
import { Pressable, Text, View } from 'react-native'
import { Bell, Check, Columns2, CornerDownRight, Plus, X } from 'lucide-react-native'
import { agentStatusGroup } from '../../agents/agent-list-rows'
import { AGENT_ATTENTION_COLOR, AgentStateDot } from '../../agents/presentation/AgentStateDot'
import { BottomDrawer } from '../../components/bottom-drawer/BottomDrawer'
import {
  MobileSegmentedControl,
  type MobileSegment
} from '../../components/controls/MobileSegmentedControl'
import { ListGroup, SectionHeader } from '../../components/list/ListGroup'
import { SwipeRowActions } from '../../components/list/SwipeRowActions'
import { TailClippedText } from '../../components/list/TailClippedText'
import { NavBarButton } from '../../components/nav-bar/NavBarButton'
import { SheetHeader } from '../../components/nav-bar/SheetHeader'
import { useNow } from '../../hooks/use-now'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { colors, radii, spacing } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { formatTimeAgo, type AgentDotState } from '../../worktree/agent-lineage/agent-row-display'
import { MobileForkMarkedName } from '../fork/MobileForkMarkedName'
import { mobileForkAccessibleName } from '../fork/mobile-fork-marked-name'
import type { MobileSessionController } from '../use-mobile-session-controller'
import { MobileSessionTabMark } from './MobileSessionTabMark'
import { MobileSessionTabsRecentBody } from './MobileSessionTabsRecentBody'
import {
  DEFAULT_MOBILE_SESSION_TABS_SHEET_SCOPE,
  type MobileSessionTabsSheetScope
} from './mobile-session-tab-bar-mode'
import {
  buildMobileSessionTabRow,
  groupMobileSessionSplitTabs,
  isForkedChatTab,
  type MobileSessionTabEntry,
  type MobileSessionTabGroup,
  type MobileSessionTabRow,
  type MobileSessionTabSummary
} from './mobile-session-tab-rows'
import { useMobileSessionTabsSheetScope } from './use-mobile-session-tab-bar-mode'

const TILE_SIZE = 34
const TILE_DOT_RING = 2
const GROUP_ORDER: readonly MobileSessionTabGroup[] = ['needs-you', 'working', 'other']

type Entry = MobileSessionTabEntry<MobileSessionTabRow>

const entryGroup = (entry: Entry): MobileSessionTabGroup =>
  entry.kind === 'tab' ? entry.tab.group : entry.group

/** Switcher sheet: `Recent` (cross-workspace MRU) and `This workspace` (needs you first; tap to open, swipe to close). */
export function MobileSessionTabsSheet({
  controller,
  tabs,
  visible,
  onClose,
  initialScope = DEFAULT_MOBILE_SESSION_TABS_SHEET_SCOPE,
  stickyScope = true
}: {
  controller: MobileSessionController
  tabs: readonly MobileSessionTabSummary[]
  visible: boolean
  onClose: () => void
  initialScope?: MobileSessionTabsSheetScope
  stickyScope?: boolean
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
        initialScope={initialScope}
        stickyScope={stickyScope}
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
  initialScope,
  stickyScope,
  onClose,
  onOpenNewTab
}: {
  controller: MobileSessionController
  tabs: readonly MobileSessionTabSummary[]
  initialScope: MobileSessionTabsSheetScope
  stickyScope: boolean
  onClose: () => void
  onOpenNewTab: () => void
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const now = useNow(60_000)
  const {
    activeSessionTabId,
    worktreeId,
    worktreeName,
    switchSessionTab,
    handleCloseSessionTab,
    createTabBusy,
    connState,
    showRecentSessionCardsAction,
    recentSessionCards
  } = controller
  const canShowRecent = Boolean(showRecentSessionCardsAction)
  const persistedScope = useMobileSessionTabsSheetScope()
  const [localScope, setLocalScope] = useState<MobileSessionTabsSheetScope>(initialScope)
  const activeScope: MobileSessionTabsSheetScope = !canShowRecent
    ? 'workspace'
    : stickyScope
      ? persistedScope.scope
      : localScope
  const handleSelectScope = (next: MobileSessionTabsSheetScope) => {
    if (stickyScope) {
      persistedScope.setScope(next)
    } else {
      setLocalScope(next)
    }
  }
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

  const recentNeedsYou = (recentSessionCards ?? []).some(
    (card) =>
      !(
        Boolean(worktreeId) &&
        Boolean(activeSessionTabId) &&
        card.worktreeId === worktreeId &&
        card.tabId === activeSessionTabId
      ) &&
      card.agentState !== undefined &&
      agentStatusGroup(card.agentState) === 'needs-you'
  )
  const workspaceNeedsYou = tabs.some(
    (row) => row.tab.id !== activeSessionTabId && row.group === 'needs-you'
  )
  const segments: MobileSegment<MobileSessionTabsSheetScope>[] = [
    {
      value: 'recent',
      label: t('session.tabsSheet.recentSegment', 'Recent'),
      trailing: recentNeedsYou ? <View style={styles.segmentDot} /> : undefined
    },
    {
      value: 'workspace',
      label: t('session.tabsSheet.workspaceSegment', 'This workspace ({{count}})', {
        count: entries.length
      }),
      trailing: workspaceNeedsYou ? <View style={styles.segmentDot} /> : undefined
    }
  ]

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

  const newTabButton = (
    <NavBarButton
      icon={Plus}
      disabled={createTabBusy || connState !== 'connected'}
      accessibilityLabel={t('session.tabStrip.newTab', 'New tab')}
      onPress={onOpenNewTab}
    />
  )

  return (
    <>
      {canShowRecent ? (
        <View style={styles.topRow}>
          <MobileSegmentedControl
            segments={segments}
            selected={activeScope}
            onSelect={handleSelectScope}
            fill
            onSheet
            tabs
            style={styles.segmented}
            testIDPrefix="tabs-sheet-scope-"
          />
          {newTabButton}
        </View>
      ) : (
        <SheetHeader
          title={title}
          subtitle={worktreeName || undefined}
          trailingButtons={newTabButton}
        />
      )}
      <View style={styles.body}>
        {activeScope === 'recent' ? (
          <MobileSessionTabsRecentBody controller={controller} />
        ) : (
          sections.map((section, index) => (
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
          ))
        )}
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
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingBottom: spacing.md
  },
  segmented: { flex: 1, minWidth: 0 },
  segmentDot: { width: 7, height: 7, borderRadius: radii.pill, backgroundColor: colors.statusRed },
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
  stateNeedsYou: { color: AGENT_ATTENTION_COLOR },
  time: { fontSize: 12, color: colors.textMuted, fontVariant: ['tabular-nums'] }
}))
