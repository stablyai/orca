import { useState } from 'react'
import { Text, View } from 'react-native'
import { AgentStateDot } from '../../agents/presentation/AgentStateDot'
import { ArrivalFade } from '../../components/motion/ArrivalFade'
import { TailClippedText } from '../../components/list/TailClippedText'
import { useReducedMotionEnabled } from '../../platform/accessibility/use-reduced-motion'
import type { AgentDotState } from '../../worktree/agent-lineage/agent-row-display'
import { colors } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { isForkedChatTab, type MobileSessionTabSummary } from './mobile-session-tab-rows'
import { MobileSessionTabMark } from './MobileSessionTabMark'
import { MobileForkMarkedName } from '../fork/MobileForkMarkedName'

// A tab drawn before it had any agent state (from the phone's store) fades its dot in when one lands.
function TabBarDot({ tabId, state }: { tabId: string; state: AgentDotState | undefined }) {
  const [startedEmpty] = useState({ tabId, empty: state === undefined })
  if (startedEmpty.tabId === tabId && startedEmpty.empty) {
    return <ArrivingTabBarDot state={state} />
  }
  return state && state !== 'idle' ? <AgentStateDot state={state} decorative /> : null
}

// Mounted with the bare tab, so the motion preference is read before the dot arrives.
function ArrivingTabBarDot({ state }: { state: AgentDotState | undefined }) {
  const reducedMotion = useReducedMotionEnabled()
  if (!state || state === 'idle') {
    return null
  }
  return (
    <ArrivalFade animate={reducedMotion === false}>
      <AgentStateDot state={state} decorative />
    </ArrivalFade>
  )
}

// A path keeps its end in view, as the sheet's detail lines do.
const isPathTitle = (title: string) => /[\\/]/.test(title)

function TabBarTitle({ row }: { row: MobileSessionTabSummary }) {
  if (isForkedChatTab(row.tab)) {
    return (
      <Text style={tabBarLayerStyles.title} numberOfLines={1}>
        <MobileForkMarkedName name={row.title} />
      </Text>
    )
  }
  if (isPathTitle(row.title)) {
    return (
      <View style={tabBarLayerStyles.pathTitle}>
        <TailClippedText style={tabBarLayerStyles.title}>{row.title}</TailClippedText>
      </View>
    )
  }
  return (
    <Text style={tabBarLayerStyles.title} numberOfLines={1}>
      {row.title}
    </Text>
  )
}

/** One tab's dot, mark and title. The neighbours draw the same a width aside, until a swipe brings one in. */
export function MobileSessionTabBarLayer({
  row,
  live
}: {
  row: MobileSessionTabSummary
  /** The open tab, whose dot fades in when its first state lands. */
  live: boolean
}) {
  useMobileColorScheme()
  const state = row.dotState && row.dotState !== 'idle' ? row.dotState : undefined
  return (
    <>
      {live ? (
        <TabBarDot tabId={row.tab.id} state={row.dotState} />
      ) : state ? (
        <AgentStateDot state={state} decorative />
      ) : null}
      <View style={tabBarLayerStyles.mark}>
        <MobileSessionTabMark row={row} size={14} />
      </View>
      <TabBarTitle row={row} />
    </>
  )
}

// The group room's thread bar draws its room with these too.
export const tabBarLayerStyles = themedStyleSheet(() => ({
  tabContent: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  // Keeps web SVGs from shrinking before the title ellipsizes.
  mark: { flexShrink: 0 },
  title: {
    flexShrink: 1,
    minWidth: 0,
    fontSize: 14,
    fontWeight: '600',
    color: colors.textPrimary
  },
  // Gives a path's tail clip the row's spare width as its edge.
  pathTitle: { flexShrink: 1, minWidth: 0 }
}))
