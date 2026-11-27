import { Fragment, memo, useMemo, useRef, useState } from 'react'
import { MobileForkMarkedName } from '../fork/MobileForkMarkedName'
import { mobileForkAccessibleName } from '../fork/mobile-fork-marked-name'
import { Pressable, Text, View } from 'react-native'
import { ChevronRight, Columns2, CornerDownRight } from 'lucide-react-native'
import { DisclosureChevron } from '../../components/list/DisclosureChevron'
import { AutoHeight, Presence } from '../../components/motion/AutoHeight'
import { SHEET_HEIGHT_DURATION_MS } from '../../components/motion/sheet-motion-values'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { agentStateLabel } from '../../worktree/agent-lineage/agent-row-display'
import { radii, spacing } from '../../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../../theme/themed-styles'
import { useMobileColors } from '../../theme/use-mobile-color-scheme'
import {
  buildMobileSessionTabRow,
  groupMobileSessionSplitTabs,
  isForkedChatTab,
  type MobileSessionTabEntry,
  type MobileSessionTabGroup,
  type MobileSessionTabRow,
  type MobileSessionTabSummary
} from './mobile-session-tab-rows'
import {
  finishedMobileSessionTabs,
  placeMobileSessionTabEntries
} from './mobile-session-tabs-sheet-sections'
import { MobileSessionTabMark } from './MobileSessionTabMark'
import { mobileSessionTabStopKind, type MobileSessionTabStop } from './MobileSessionTabStopConfirm'
import {
  SIDEBAR_MARK_SIZE,
  SidebarRow,
  SidebarRowAsk,
  SidebarRowMark,
  SidebarLabel,
  SidebarRowText,
  sidebarRowStylesSheet
} from './MobileSessionSidebarRow'
import type { MobileSessionController } from '../use-mobile-session-controller'

const GROUP_ORDER: readonly MobileSessionTabGroup[] = ['needs-you', 'working', 'other']

type Entry = MobileSessionTabEntry<MobileSessionTabRow>

/** Every tab in the workspace, what needs you first; tap one to go there, × to close it. */
// Memoized: a session update that leaves the tabs alone redraws the sidebar's shell, not every row.
export const MobileSessionSidebarTabs = memo(function MobileSessionSidebarTabs({
  activeSessionTabId,
  handleCloseSessionTab,
  tabs,
  now,
  frozen,
  onPick,
  onStopTabs
}: {
  activeSessionTabId: MobileSessionController['activeSessionTabId']
  handleCloseSessionTab: MobileSessionController['handleCloseSessionTab']
  tabs: readonly MobileSessionTabSummary[]
  now: number
  /** Rows keep their places while the sidebar is open over the session; a docked column stays live. */
  frozen: boolean
  onPick: (tab: MobileSessionTabSummary['tab']) => void
  /** Asks before a close that needs it. */
  onStopTabs: (stop: MobileSessionTabStop) => void
}) {
  const colors = useMobileColors()
  const styles = useThemedStyles(stylesSheet)
  const sidebarRowStyles = useThemedStyles(sidebarRowStylesSheet)
  const t = useMobileTranslation()
  // Why: the preview scans each agent's last message, so only the open sidebar pays for it (STA-15103).
  const rows = useMemo(() => tabs.map((tab) => buildMobileSessionTabRow(tab, t)), [tabs, t])
  const entries = useMemo(() => groupMobileSessionSplitTabs(rows), [rows])
  // Rows hold their section and fold while the sidebar is shown, so none moves under a finger.
  const [placement] = useState(() => placeMobileSessionTabEntries(entries, now, activeSessionTabId))
  const [olderOpen, setOlderOpen] = useState(false)
  // Rows on their way out: folding shut, then gone while the computer answers; a refusal brings them back.
  const [leaving, setLeaving] = useState<ReadonlyMap<string, 'folding' | 'gone'>>(new Map())
  const closingKeysRef = useRef(new Set<string>())
  const live = frozen ? null : placeMobileSessionTabEntries(entries, now, activeSessionTabId)
  const placed = entries.map((entry) => ({
    entry,
    ...((live ?? placement).get(entry.key) ??
      placeMobileSessionTabEntries([entry], now, activeSessionTabId).get(entry.key)!)
  }))
  const sections = GROUP_ORDER.map((group) => ({
    group,
    entries: placed.filter((item) => item.group === group && !item.older).map((item) => item.entry),
    older: placed.filter((item) => item.group === group && item.older).map((item) => item.entry)
  })).filter((section) => section.entries.length + section.older.length > 0)
  const finished = finishedMobileSessionTabs(rows, activeSessionTabId)
  const sectionTitles: Record<MobileSessionTabGroup, string> = {
    'needs-you': t('session.tabsSheet.needsYou', 'Needs you'),
    working: t('session.tabsSheet.working', 'Working'),
    other: t('session.tabsSheet.everythingElse', 'Everything else')
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
  const closeLabel = (title: string) =>
    t('session.tabsSheet.closeTab', 'Close {{title}}', { title })

  const renderTab = (row: MobileSessionTabRow) =>
    present(
      row.tab.id,
      row.tab.id,
      <SidebarRow
        accessibilityLabel={[
          isForkedChatTab(row.tab) ? mobileForkAccessibleName(row.title, t) : row.title,
          row.stateWord,
          row.group === 'needs-you' ? row.content : null,
          row.unread ? t('agents.list.unread', 'Unread') : null
        ]
          .filter(Boolean)
          .join(', ')}
        current={row.tab.id === activeSessionTabId}
        closeLabel={closeLabel(row.title)}
        onPress={() => onPick(row.tab)}
        onClose={() => closeRows(row.tab.id, [row])}
      >
        <SidebarRowMark
          state={row.dotState}
          mark={<MobileSessionTabMark row={row} size={SIDEBAR_MARK_SIZE - 2} />}
        />
        <SidebarRowText
          title={isForkedChatTab(row.tab) ? <MobileForkMarkedName name={row.title} /> : row.title}
          unread={row.unread}
        >
          {/* Only a waiting agent gets a second line: what it asks. */}
          {row.group === 'needs-you' ? <SidebarRowAsk row={row} /> : null}
        </SidebarRowText>
      </SidebarRow>
    )

  const renderSplit = (entry: Extract<Entry, { kind: 'split' }>) => {
    const { panes } = entry
    const splitTitle = panes.map((pane) => pane.title).join(' · ')
    const badgeState = entry.dotState !== 'idle' ? entry.dotState : undefined
    const target =
      panes.find((pane) => pane.tab.id === activeSessionTabId) ??
      panes.find((pane) => pane.tab.isActive) ??
      panes[0]
    const splitKey = `split:${entry.key}`
    return [
      ...present(
        splitKey,
        splitKey,
        <SidebarRow
          accessibilityLabel={[
            splitTitle,
            panes.length === 1
              ? t('session.tabsSheet.panes_one', '{{count}} pane', { count: panes.length })
              : t('session.tabsSheet.panes_other', '{{count}} panes', { count: panes.length }),
            badgeState ? agentStateLabel(badgeState, t) : null,
            entry.unread ? t('agents.list.unread', 'Unread') : null
          ]
            .filter(Boolean)
            .join(', ')}
          closeLabel={closeLabel(splitTitle)}
          onPress={() => onPick(target.tab)}
          onClose={() => closeRows(splitKey, panes)}
        >
          <SidebarRowMark
            state={badgeState}
            mark={
              <Columns2 size={SIDEBAR_MARK_SIZE - 2} color={colors.textSecondary} strokeWidth={2} />
            }
          />
          <SidebarRowText title={splitTitle} unread={entry.unread} />
        </SidebarRow>
      ),
      ...panes.flatMap((row) =>
        present(
          row.tab.id,
          splitKey,
          <SidebarRow
            accessibilityLabel={[row.title, row.stateWord].filter(Boolean).join(', ')}
            current={row.tab.id === activeSessionTabId}
            pane
            onPress={() => onPick(row.tab)}
          >
            <CornerDownRight size={14} color={colors.textMuted} strokeWidth={2} />
            <SidebarRowText title={row.title} unread={false} />
          </SidebarRow>
        )
      )
    ]
  }
  const renderEntries = (list: readonly Entry[]) =>
    list.flatMap((entry) => (entry.kind === 'tab' ? renderTab(entry.tab) : renderSplit(entry)))

  // Older tabs fold under the section's last row.
  const olderFold = (older: readonly Entry[]) => (
    <View key="older">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: olderOpen }}
        style={({ pressed }) => [styles.foldRow, pressed && sidebarRowStyles.filled]}
        onPress={() => setOlderOpen(!olderOpen)}
      >
        <View style={sidebarRowStyles.mark}>
          <DisclosureChevron expanded={olderOpen} collapsedDeg={0} expandedDeg={90}>
            <ChevronRight size={15} color={colors.textMuted} />
          </DisclosureChevron>
        </View>
        <Text style={styles.quiet}>
          {t('session.tabsSheet.olderCount', '{{count}} older', { count: older.length })}
        </Text>
      </Pressable>
      <AutoHeight open={olderOpen}>{renderEntries(older)}</AutoHeight>
    </View>
  )

  return (
    <>
      {sections.map((section) => (
        <Fragment key={section.group}>
          <SidebarLabel
            title={sectionTitles[section.group]}
            count={section.entries.length + section.older.length}
          />
          {renderEntries(section.entries)}
          {section.older.length > 0 ? olderFold(section.older) : null}
        </Fragment>
      ))}
      {finished.length > 1 ? (
        // Quiet, not red: one tap closes only done agents already read, and it asks first.
        <Pressable
          accessibilityRole="button"
          style={({ pressed }) => [styles.quietRow, pressed && sidebarRowStyles.filled]}
          onPress={() =>
            onStopTabs({ tabs: finished.map((row) => row.tab), title: '', kind: 'finished' })
          }
        >
          <Text style={styles.quietRowText}>
            {finished.length === 1
              ? t('session.tabsSheet.closeFinished_one', 'Close {{count}} finished tab', {
                  count: finished.length
                })
              : t('session.tabsSheet.closeFinished_other', 'Close {{count}} finished tabs', {
                  count: finished.length
                })}
          </Text>
        </Pressable>
      ) : null}
    </>
  )
})

const stylesSheet = themedStyleSheet((colors) => ({
  // Agents list's fold: chevron, then "3 older", lined up with the row text.
  foldRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 44,
    paddingLeft: spacing.md,
    borderRadius: radii.control
  },
  quiet: { fontSize: 14, color: colors.textSecondary },
  quietRow: {
    minHeight: 44,
    justifyContent: 'center',
    paddingLeft: spacing.md,
    marginTop: spacing.xs,
    borderRadius: radii.control
  },
  quietRowText: { fontSize: 15, color: colors.textSecondary }
}))
