import { useCallback, useEffect, useRef } from 'react'
import { Pressable, ScrollView, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Plus } from 'lucide-react-native'
import { StatusDot } from '../../components/feedback/StatusDot'
import { useNow } from '../../hooks/use-now'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { feedback, radii, spacing } from '../../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../../theme/themed-styles'
import { useMobileColors } from '../../theme/use-mobile-color-scheme'
import type { MobileSessionController } from '../use-mobile-session-controller'
import type { MobileSessionTabSummary } from './mobile-session-tab-rows'
import { MobileSessionOtherWorkspaces } from './MobileSessionOtherWorkspaces'
import { MobileSessionSidebarPlaces } from './MobileSessionSidebarPlaces'
import { MobileSessionSidebarTabs } from './MobileSessionSidebarTabs'
import {
  useTabSummaries,
  type MobileSessionTabSummaryChannel
} from './use-mobile-session-tab-summaries'
import { SidebarFade } from './MobileSessionSidebarFade'
import {
  useMobileSessionTabStopConfirm,
  type MobileSessionTabStop
} from './MobileSessionTabStopConfirm'
import type { MobileSessionSidebar as SidebarState } from './use-mobile-session-sidebar'

const PILL_HEIGHT = 48

/** The sidebar's contents: the workspace, its places, its tabs (what needs you first), other workspaces. */
export function MobileSessionSidebar({
  controller,
  sidebar,
  summaries,
  place,
  connectionIssue
}: {
  controller: MobileSessionController
  sidebar: SidebarState
  /** The top bar's tab summaries, read here rather than built twice. */
  summaries: MobileSessionTabSummaryChannel
  /** The branch or project, or what's wrong with the connection. */
  place: string
  connectionIssue: boolean
}) {
  const colors = useMobileColors()
  const styles = useThemedStyles(stylesSheet)
  const t = useMobileTranslation()
  const insets = useSafeAreaInsets()
  const tabs = useTabSummaries(summaries)
  // The sidebar's one clock: the Older fold and the other workspaces' times read it.
  const now = useNow(60_000)
  const {
    hostId,
    worktreeId,
    worktreeName,
    activeSessionTabId,
    switchSessionTab,
    handleCloseSessionTab,
    handleOpenNewTab,
    createTabBusy,
    connState,
    statusDot
  } = controller
  const stopConfirm = useMobileSessionTabStopConfirm(
    handleCloseSessionTab,
    tabs,
    activeSessionTabId
  )
  const pick = (tab: MobileSessionTabSummary['tab']) => {
    if (tab.id !== activeSessionTabId) {
      switchSessionTab(tab)
    }
    if (!sidebar.docked) {
      sidebar.close()
    }
  }
  // Stable for the memoized tab list; each call runs this render's handlers.
  const latest = useRef({ pick, ask: stopConfirm.ask, close: handleCloseSessionTab })
  useEffect(() => {
    latest.current = { pick, ask: stopConfirm.ask, close: handleCloseSessionTab }
  })
  const onPick = useCallback((tab: MobileSessionTabSummary['tab']) => latest.current.pick(tab), [])
  const closeTab = useCallback<typeof handleCloseSessionTab>(
    (tab, closingTogether) => latest.current.close(tab, closingTogether),
    []
  )
  const onStopTabs = useCallback((stop: MobileSessionTabStop) => latest.current.ask(stop), [])
  const createDisabled = createTabBusy || connState !== 'connected'
  const pillBottom = insets.bottom + spacing.md
  return (
    <View style={styles.panel}>
      <ScrollView
        contentContainerStyle={[
          styles.content,
          {
            paddingTop: insets.top + spacing.md,
            paddingBottom: pillBottom + PILL_HEIGHT + spacing.lg
          }
        ]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.title}>
          <Text style={styles.titleText} numberOfLines={2} accessibilityRole="header">
            {worktreeName || t('session.header.terminalTitle', 'Terminal')}
          </Text>
          <View style={styles.placeRow}>
            {connectionIssue ? (
              <StatusDot state={statusDot.state} verdict={statusDot.verdict} />
            ) : null}
            <Text style={styles.placeText} numberOfLines={1}>
              {place}
            </Text>
          </View>
        </View>
        <MobileSessionSidebarPlaces controller={controller} sidebar={sidebar} />
        <MobileSessionSidebarTabs
          activeSessionTabId={activeSessionTabId}
          handleCloseSessionTab={closeTab}
          tabs={tabs}
          now={now}
          frozen={!sidebar.docked}
          onPick={onPick}
          onStopTabs={onStopTabs}
        />
        <MobileSessionOtherWorkspaces hostId={hostId} worktreeId={worktreeId} now={now} />
      </ScrollView>
      <SidebarFade height={pillBottom + PILL_HEIGHT + spacing.xl} />
      <Pressable
        style={({ pressed }) => [
          styles.pill,
          { bottom: pillBottom },
          pressed && styles.pillPressed,
          createDisabled && styles.pillDisabled
        ]}
        disabled={createDisabled}
        onPress={() => {
          // The New tab sheet covers everything; the new tab opens onto the session, not the sidebar.
          if (!sidebar.docked) {
            sidebar.close()
          }
          handleOpenNewTab()
        }}
        accessibilityRole="button"
        accessibilityState={{ disabled: createDisabled }}
      >
        <Plus size={18} color={colors.bgBase} strokeWidth={2.4} />
        <Text style={styles.pillText}>{t('session.sheets.newTab', 'New tab')}</Text>
      </Pressable>
      {stopConfirm.confirm}
    </View>
  )
}

const stylesSheet = themedStyleSheet((colors, scheme) => ({
  panel: {
    flex: 1,
    backgroundColor: scheme === 'dark' ? colors.bgPanel : colors.bgRaised
  },
  // Row fills run 8 pt in from the panel's left and 4 from its right, so marks sit 20 pt in.
  content: { paddingLeft: spacing.sm, paddingRight: spacing.xs },
  // PageTitle's type, 24 pt: never iOS's 34 pt large title.
  title: { paddingLeft: spacing.md, paddingRight: spacing.sm, gap: 3 },
  titleText: {
    color: colors.textPrimary,
    fontSize: 24,
    lineHeight: 30,
    fontWeight: '700',
    letterSpacing: -0.3
  },
  placeRow: { flexDirection: 'row', alignItems: 'center', gap: 5, minWidth: 0 },
  placeText: { flexShrink: 1, fontSize: 13, lineHeight: 18, color: colors.textSecondary },
  // Home's floating button, as a labelled pill in the sidebar's ink.
  pill: {
    position: 'absolute',
    right: spacing.lg,
    height: PILL_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingLeft: spacing.lg,
    paddingRight: 20,
    borderRadius: radii.pill,
    backgroundColor: colors.textPrimary,
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 5 },
    elevation: 6
  },
  pillPressed: { transform: [{ scale: 0.96 }] },
  pillDisabled: { opacity: feedback.disabledOpacity },
  pillText: { fontSize: 16, fontWeight: '600', color: colors.bgBase }
}))
