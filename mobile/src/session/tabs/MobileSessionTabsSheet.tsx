import { Fragment, useMemo, useRef, useState } from 'react'
import { MobileForkMarkedName } from '../fork/MobileForkMarkedName'
import { mobileForkAccessibleName } from '../fork/mobile-fork-marked-name'
import { Text, View } from 'react-native'
import { Columns2, CornerDownRight, Plus } from 'lucide-react-native'
import { BottomDrawer } from '../../components/bottom-drawer/BottomDrawer'
import { ListGroup, SectionHeader } from '../../components/list/ListGroup'
import { NavBarButton } from '../../components/nav-bar/NavBarButton'
import { SheetHeader } from '../../components/nav-bar/SheetHeader'
import { Presence } from '../../components/motion/AutoHeight'
import { SHEET_HEIGHT_DURATION_MS } from '../../components/motion/sheet-motion-values'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useNow } from '../../hooks/use-now'
import { agentStateLabel, formatTimeAgo } from '../../worktree/agent-lineage/agent-row-display'
import { colors, spacing } from '../../theme/mobile-theme'
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
import { mobileSessionTabStopKind, type MobileSessionTabStop } from './MobileSessionTabStopConfirm'
import {
  TABS_SHEET_TILE_SIZE,
  TabsSheetRow,
  TabsSheetRowDetail,
  TabsSheetTile,
  tabsSheetRowStyles
} from './MobileSessionTabsSheetRow'
import type { MobileSessionController } from '../use-mobile-session-controller'

const GROUP_ORDER: readonly MobileSessionTabGroup[] = ['needs-you', 'working', 'other']

type Entry = MobileSessionTabEntry<MobileSessionTabRow>

const entryGroup = (entry: Entry): MobileSessionTabGroup =>
  entry.kind === 'tab' ? entry.tab.group : entry.group

/** Every tab in the workspace, what needs you first; tap one to go there, × to close it. */
export function MobileSessionTabsSheet({
  controller,
  tabs,
  visible,
  onClose,
  onStopTabs
}: {
  controller: MobileSessionController
  tabs: readonly MobileSessionTabSummary[]
  visible: boolean
  onClose: () => void
  /** Asks before closing a running agent; called once this sheet has gone (nested modals, #10331). */
  onStopTabs: (stop: MobileSessionTabStop) => void
}) {
  const afterCloseRef = useRef<(() => void) | null>(null)
  const closeThen = (afterClose: () => void) => {
    afterCloseRef.current = afterClose
    onClose()
  }
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
        // The new-tab sheet is its own drawer; open it once this one is gone.
        onOpenNewTab={() => closeThen(controller.handleOpenNewTab)}
        onStopTabs={(stop) => closeThen(() => onStopTabs(stop))}
      />
    </BottomDrawer>
  )
}

function MobileSessionTabsSheetContent({
  controller,
  tabs,
  onClose,
  onOpenNewTab,
  onStopTabs
}: {
  controller: MobileSessionController
  tabs: readonly MobileSessionTabSummary[]
  onClose: () => void
  onOpenNewTab: () => void
  onStopTabs: (stop: MobileSessionTabStop) => void
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
  // Rows on their way out: folding shut, then gone while the computer answers; a refusal brings them back.
  const [leaving, setLeaving] = useState<ReadonlyMap<string, 'folding' | 'gone'>>(new Map())
  const closingKeysRef = useRef(new Set<string>())
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

  // Keyed by entry and by every pane, so a split that drops to one pane mid-close stays hidden.
  const setLeavingState = (keys: readonly string[], state: 'folding' | 'gone' | null) =>
    setLeaving((previous) => {
      const next = new Map(previous)
      for (const key of keys) {
        if (state === null) {
          next.delete(key)
        } else {
          next.set(key, state)
        }
      }
      return next
    })
  // The row folds shut first, so the reply removes a row that is already out of sight instead of jumping the list.
  // Closing every pane closes the desktop tab, on hosts old and new.
  const closeRows = (key: string, closing: readonly MobileSessionTabRow[]) => {
    // A second tap while the row folds would close it twice and report a failure.
    if (closingKeysRef.current.has(key)) {
      return
    }
    // Any pane still running asks first, whatever the split's most urgent state says.
    const running = closing.find((row) => mobileSessionTabStopKind(row.dotState) !== null)
    const stop = running ? mobileSessionTabStopKind(running.dotState) : null
    if (running && stop) {
      onStopTabs({ tabs: closing.map((row) => row.tab), title: running.title, kind: stop })
      return
    }
    closingKeysRef.current.add(key)
    const ids = closing.map((row) => row.tab.id)
    const keys = [key, ...ids]
    setLeavingState(keys, 'folding')
    setTimeout(() => {
      setLeavingState(keys, 'gone')
      void (async () => {
        for (const row of closing) {
          await handleCloseSessionTab(row.tab, ids)
        }
        setLeavingState(keys, null)
        closingKeysRef.current.delete(key)
      })()
    }, SHEET_HEIGHT_DURATION_MS)
  }

  // Each row folds on its own, keyed apart from its entry so a split's panes fold with their tab.
  const present = (key: string, entryKey: string, row: React.JSX.Element) => {
    const state = leaving.get(entryKey) ?? leaving.get(key)
    if (state === 'gone') {
      return []
    }
    return [<Presence key={key}>{state === 'folding' ? null : row}</Presence>]
  }

  const renderTab = (row: MobileSessionTabRow) => {
    const current = row.tab.id === activeSessionTabId
    const time = row.timeAt !== null ? formatTimeAgo(row.timeAt, now) : ''
    return present(
      row.tab.id,
      row.tab.id,
      <TabsSheetRow
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
        onClose={() => closeRows(row.tab.id, [row])}
      >
        <TabsSheetTile
          badge={row.dotState}
          unreadBell={row.unread && row.group === 'other'}
          mark={<MobileSessionTabMark row={row} size={17} />}
        />
        <View style={tabsSheetRowStyles.text}>
          <Text style={tabsSheetRowStyles.title} numberOfLines={1}>
            {isForkedChatTab(row.tab) ? <MobileForkMarkedName name={row.title} /> : row.title}
          </Text>
          <TabsSheetRowDetail row={row} />
        </View>
        {time ? <Text style={tabsSheetRowStyles.time}>{time}</Text> : null}
      </TabsSheetRow>
    )
  }

  const renderSplit = (entry: Extract<Entry, { kind: 'split' }>) => {
    const { panes } = entry
    const splitTitle = panes[0].title
    const unreadBell = entry.unread && entry.group === 'other'
    const badgeState = !unreadBell && entry.dotState !== 'idle' ? entry.dotState : undefined
    const paneCount =
      panes.length === 1
        ? t('session.tabsSheet.panes_one', '{{count}} pane', { count: panes.length })
        : t('session.tabsSheet.panes_other', '{{count}} panes', { count: panes.length })
    const target =
      panes.find((pane) => pane.tab.id === activeSessionTabId) ??
      panes.find((pane) => pane.tab.isActive) ??
      panes[0]
    const splitKey = `split:${entry.key}`
    return [
      ...present(
        splitKey,
        splitKey,
        <TabsSheetRow
          title={splitTitle}
          accessibilityLabel={[
            splitTitle,
            paneCount,
            badgeState ? agentStateLabel(badgeState) : null,
            entry.unread ? t('agents.list.unread', 'Unread') : null
          ]
            .filter(Boolean)
            .join(', ')}
          current={false}
          onPress={() => open(target.tab)}
          onClose={() => closeRows(splitKey, panes)}
        >
          <TabsSheetTile
            badge={badgeState}
            unreadBell={unreadBell}
            mark={<Columns2 size={17} color={colors.textSecondary} strokeWidth={2.1} />}
          />
          <View style={tabsSheetRowStyles.text}>
            <Text style={tabsSheetRowStyles.title} numberOfLines={1}>
              {splitTitle}
            </Text>
            <Text style={tabsSheetRowStyles.detail} numberOfLines={1}>
              {paneCount}
            </Text>
          </View>
        </TabsSheetRow>
      ),
      ...panes.flatMap((row) =>
        present(
          row.tab.id,
          splitKey,
          <TabsSheetRow
            title={row.title}
            accessibilityLabel={[row.title, row.stateWord, row.content].filter(Boolean).join(', ')}
            current={row.tab.id === activeSessionTabId}
            pane
            onPress={() => open(row.tab)}
            onClose={() => closeRows(row.tab.id, [row])}
          >
            <View style={tabsSheetRowStyles.paneMark}>
              <CornerDownRight size={14} color={colors.textMuted} strokeWidth={2} />
            </View>
            <View style={tabsSheetRowStyles.text}>
              <Text style={tabsSheetRowStyles.paneTitle} numberOfLines={1}>
                {row.title}
              </Text>
              <TabsSheetRowDetail row={row} />
            </View>
          </TabsSheetRow>
        )
      )
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
      <View style={tabsSheetRowStyles.body}>
        {sections.map((section, index) => (
          <Fragment key={section.group}>
            {sections.length > 1 ? (
              <SectionHeader title={sectionTitles[section.group]} first={index === 0} />
            ) : null}
            <ListGroup separatorInset={spacing.lg + TABS_SHEET_TILE_SIZE + spacing.md}>
              {section.entries.flatMap((entry) =>
                entry.kind === 'tab' ? renderTab(entry.tab) : renderSplit(entry)
              )}
            </ListGroup>
          </Fragment>
        ))}
      </View>
    </>
  )
}
