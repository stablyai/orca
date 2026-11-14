import { Fragment, useMemo, useRef, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { Plus, X } from 'lucide-react-native'
import { BottomDrawer } from '../../components/bottom-drawer/BottomDrawer'
import { ListGroup, SectionHeader } from '../../components/list/ListGroup'
import { NavBarButton } from '../../components/nav-bar/NavBarButton'
import { SheetHeader } from '../../components/nav-bar/SheetHeader'
import { SwipeRowActions } from '../../components/SwipeRowActions'
import { AgentStateDot } from '../../components/AgentStateDot'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useNow } from '../../hooks/use-now'
import { formatTimeAgo } from '../../worktree/agent-lineage/agent-row-display'
import { colors, radii, spacing } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import {
  buildMobileSessionTabRow,
  type MobileSessionTabGroup,
  type MobileSessionTabRow,
  type MobileSessionTabSummary
} from './mobile-session-tab-rows'
import { MobileSessionTabMark } from './MobileSessionTabMark'
import type { MobileSessionController } from '../use-mobile-session-controller'

const TILE_SIZE = 34
const TILE_DOT_RING = 2
const GROUP_ORDER: readonly MobileSessionTabGroup[] = ['needs-you', 'working', 'other']

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
  const title =
    rows.length === 1
      ? t('session.tabBar.oneTab', '1 tab')
      : t('session.tabBar.tabCount', '{{count}} tabs', { count: rows.length })

  const renderRow = (row: MobileSessionTabRow) => {
    const current = row.tab.id === activeSessionTabId
    const badge = row.dotState && row.dotState !== 'idle' ? row.dotState : undefined
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
            accessibilityLabel={[row.title, row.detail, time].filter(Boolean).join(', ')}
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
                  {badge ? (
                    <View style={styles.tileBadge}>
                      <AgentStateDot state={badge} />
                    </View>
                  ) : null}
                </View>
                <View style={styles.text}>
                  <Text style={styles.title} numberOfLines={1}>
                    {row.title}
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
      <View>
        <SheetHeader title={title} subtitle={worktreeName || undefined} />
        <View style={styles.newTab}>
          <NavBarButton
            icon={Plus}
            disabled={createTabBusy || connState !== 'connected'}
            accessibilityLabel={t('session.tabStrip.newTab', 'New tab')}
            onPress={onOpenNewTab}
          />
        </View>
      </View>
      <View style={styles.body}>
        {sections.map((section, index) => (
          <Fragment key={section.group}>
            {sections.length > 1 ? (
              <SectionHeader title={sectionTitles[section.group]} first={index === 0} />
            ) : null}
            <ListGroup separatorInset={spacing.lg + TILE_SIZE + spacing.md}>
              {section.rows.map(renderRow)}
            </ListGroup>
          </Fragment>
        ))}
      </View>
    </>
  )
}

const styles = themedStyleSheet(() => ({
  // Over the sheet header's empty trailing side, centred in its 52pt row.
  newTab: { position: 'absolute', top: 8, right: spacing.xs },
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
