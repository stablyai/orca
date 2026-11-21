import { Fragment, useMemo, useRef, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { Bell, Plus, X } from 'lucide-react-native'
import { agentStatusGroup } from '../../agents/agent-list-rows'
import { AgentStateDot } from '../../agents/presentation/AgentStateDot'
import { BottomDrawer } from '../../components/bottom-drawer/BottomDrawer'
import {
  MobileSegmentedControl,
  type MobileSegment
} from '../../components/controls/MobileSegmentedControl'
import { ListGroup, SectionHeader } from '../../components/list/ListGroup'
import { SwipeRowActions } from '../../components/list/SwipeRowActions'
import { NavBarButton } from '../../components/nav-bar/NavBarButton'
import { SheetHeader } from '../../components/nav-bar/SheetHeader'
import { useNow } from '../../hooks/use-now'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { colors, radii, spacing } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { formatTimeAgo } from '../../worktree/agent-lineage/agent-row-display'
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
  isForkedChatTab,
  type MobileSessionTabGroup,
  type MobileSessionTabRow,
  type MobileSessionTabSummary
} from './mobile-session-tab-rows'
import { useMobileSessionTabsSheetScope } from './use-mobile-session-tab-bar-mode'

const TILE_SIZE = 34
const TILE_DOT_RING = 2
const GROUP_ORDER: readonly MobileSessionTabGroup[] = ['needs-you', 'working', 'other']

/** Switcher sheet offering `Recent` (cross-workspace MRU) and `This workspace` (grouped + swipe close). */
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

  // Sections hold still while the sheet is shown (closing included), so a row never moves under a finger.
  const [frozenGroups] = useState<ReadonlyMap<string, MobileSessionTabGroup>>(
    () => new Map(tabs.map((tab) => [tab.tab.id, tab.group]))
  )
  const rows = useMemo(() => tabs.map((tab) => buildMobileSessionTabRow(tab)), [tabs])
  const sections = GROUP_ORDER.map((group) => ({
    group,
    rows: rows.filter((row) => (frozenGroups.get(row.tab.id) ?? row.group) === group)
  })).filter((section) => section.rows.length > 0)
  const sectionTitles: Record<MobileSessionTabGroup, string> = {
    'needs-you': t('session.tabsSheet.needsYou', 'Needs you'),
    working: t('session.tabsSheet.working', 'Working'),
    other: t('session.tabsSheet.everythingElse', 'Everything else')
  }
  const workspaceCountTitle =
    rows.length === 1
      ? t('session.tabBar.oneTab', '1 tab')
      : t('session.tabBar.tabCount', '{{count}} tabs', { count: rows.length })

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
        count: rows.length
      }),
      trailing: workspaceNeedsYou ? <View style={styles.segmentDot} /> : undefined
    }
  ]

  const renderRow = (row: MobileSessionTabRow) => {
    const current = row.tab.id === activeSessionTabId
    const badge = row.dotState && row.dotState !== 'idle' ? row.dotState : undefined
    const unreadBell =
      row.unread &&
      row.group === 'other' &&
      (!badge || (agentStatusGroup(badge) !== 'needs-you' && agentStatusGroup(badge) !== 'working'))
    const time = current
      ? t('session.tabsSheet.open', 'Open')
      : row.timeAt !== null
        ? formatTimeAgo(row.timeAt, now)
        : ''
    return (
      <SwipeRowActions
        key={row.tab.id}
        trailing={{
          label: t('common.close', 'Close'),
          accessibilityLabel: t('session.tabsSheet.closeTab', 'Close {{title}}', {
            title: row.title
          }),
          icon: X,
          background: colors.statusRed,
          foreground: colors.onStatusRed,
          onPress: () => void handleCloseSessionTab(row.tab)
        }}
      >
        {(guardPress) => (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={[
              isForkedChatTab(row.tab) ? mobileForkAccessibleName(row.title) : row.title,
              row.detail,
              row.unread ? t('agents.list.unread', 'Unread') : null,
              time
            ]
              .filter(Boolean)
              .join(', ')}
            accessibilityState={{ selected: current }}
            style={styles.row}
            onPress={guardPress(() => {
              if (!current) {
                switchSessionTab(row.tab)
              }
              onClose()
            })}
          >
            {({ pressed }) => (
              <>
                {current || pressed ? <View pointerEvents="none" style={styles.wash} /> : null}
                <View style={styles.tile}>
                  <MobileSessionTabMark row={row} size={17} />
                  {unreadBell || badge ? (
                    <View style={styles.tileBadge}>
                      {unreadBell ? (
                        <Bell
                          size={10}
                          color={colors.statusAmber}
                          fill={colors.statusAmber}
                          accessibilityLabel={t('agents.list.unread', 'Unread')}
                        />
                      ) : badge ? (
                        <AgentStateDot state={badge} />
                      ) : null}
                    </View>
                  ) : null}
                </View>
                <View style={styles.text}>
                  <Text style={styles.title} numberOfLines={1}>
                    {isForkedChatTab(row.tab) ? (
                      <MobileForkMarkedName name={row.title} />
                    ) : (
                      row.title
                    )}
                  </Text>
                  <Text style={styles.detail} numberOfLines={1}>
                    {row.detail}
                  </Text>
                </View>
                {time ? (
                  <Text style={[styles.time, current && styles.timeCurrent]}>{time}</Text>
                ) : null}
              </>
            )}
          </Pressable>
        )}
      </SwipeRowActions>
    )
  }

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
          <NavBarButton
            icon={Plus}
            disabled={createTabBusy || connState !== 'connected'}
            accessibilityLabel={t('session.tabStrip.newTab', 'New tab')}
            onPress={onOpenNewTab}
          />
        </View>
      ) : (
        <View>
          <SheetHeader title={workspaceCountTitle} subtitle={worktreeName || undefined} />
          <View style={styles.newTab}>
            <NavBarButton
              icon={Plus}
              disabled={createTabBusy || connState !== 'connected'}
              accessibilityLabel={t('session.tabStrip.newTab', 'New tab')}
              onPress={onOpenNewTab}
            />
          </View>
        </View>
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
                {section.rows.map(renderRow)}
              </ListGroup>
            </Fragment>
          ))
        )}
      </View>
    </>
  )
}

const styles = themedStyleSheet(() => ({
  // Over the fallback sheet header's empty trailing side, centred in its 52pt row.
  newTab: { position: 'absolute', top: 8, right: spacing.xs },
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
    minHeight: 60,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    backgroundColor: colors.sheetGroup
  },
  // The tab you're in, or a pressed row, washed like a picked segment on a sheet group.
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
  text: { flex: 1, minWidth: 0, gap: 2 },
  title: { fontSize: 15, fontWeight: '600', color: colors.textPrimary },
  detail: { fontSize: 13, color: colors.textSecondary },
  time: { fontSize: 12, color: colors.textMuted, fontVariant: ['tabular-nums'] },
  timeCurrent: { fontWeight: '600', color: colors.accentBlue }
}))
