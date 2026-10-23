import { Pressable, StyleSheet, Text, View } from 'react-native'
import { File, FileText, Globe, SquareTerminal, X } from 'lucide-react-native'
import { MobileAgentIcon } from '../components/MobileAgentIcon'
import { pressTransition } from '../components/ui/transition-styles'
import { colors, textStyles } from '../theme/mobile-theme'
import { agentStateLabel, type AgentDotState } from '../worktree/agent-row-display'
import type { MobileSessionTab } from './mobile-session-route-types'
import { resolveMobileTerminalTabAgentId } from './mobile-terminal-tab-agent'

export const TAB_HEIGHT = 34

// Not the dot vocabulary's hexes: the bar's 7 pt dot is a summary in the status tokens.
export const TAB_DOT_COLORS: Partial<Record<AgentDotState, string>> = {
  working: colors.statusAmber,
  monitoring: colors.statusAmber,
  waiting: colors.statusAmber,
  blocked: colors.statusAmber,
  done: colors.statusGreen,
  failed: colors.statusRed
}

type Props = {
  tab: MobileSessionTab
  title: string
  hostAgentIdentity: string | undefined
  state: AgentDotState | undefined
  active: boolean
  /** The hairline before the tab, gone beside the active pill so it reads as one shape. */
  dividerHidden: boolean
  width: number
  onLayout: (x: number, width: number) => void
  onPress: () => void
  onLongPress: () => void
  onClose: () => void
}

/** One capsule tab: status dot, icon, name; the active one also carries its close button. */
export function MobileSessionTabStripTab({
  tab,
  title,
  hostAgentIdentity,
  state,
  active,
  dividerHidden,
  width,
  onLayout,
  onPress,
  onLongPress,
  onClose
}: Props) {
  const dotColor = state ? TAB_DOT_COLORS[state] : undefined
  return (
    <Pressable
      style={[styles.touch, { width }]}
      onLayout={(e) => onLayout(e.nativeEvent.layout.x, e.nativeEvent.layout.width)}
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={400}
      accessibilityRole="tab"
      accessibilityLabel={state && state !== 'idle' ? `${title}, ${agentStateLabel(state)}` : title}
      accessibilityHint="Long press for tab actions"
      accessibilityState={{ selected: active }}
    >
      {({ pressed }) => (
        <View
          style={[
            styles.tab,
            active && styles.tabActive,
            pressed && !active && styles.tabPressed,
            pressed ? pressTransition.pressed : pressTransition.rest
          ]}
        >
          <View
            style={[styles.divider, dividerHidden && styles.dividerHidden]}
            pointerEvents="none"
          />
          {dotColor ? <View style={[styles.statusDot, { backgroundColor: dotColor }]} /> : null}
          <View style={styles.icon}>
            <TabIcon tab={tab} hostAgentIdentity={hostAgentIdentity} active={active} />
          </View>
          <Text style={[styles.label, active && styles.labelActive]} numberOfLines={1}>
            {title}
          </Text>
          {active ? (
            <Pressable
              style={styles.closeTouch}
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel={`Close ${title}`}
            >
              {({ pressed: closePressed }) => (
                <View
                  style={[
                    styles.close,
                    closePressed && styles.closePressed,
                    closePressed ? pressTransition.pressed : pressTransition.rest
                  ]}
                >
                  <X
                    size={13}
                    color={closePressed ? colors.textPrimary : colors.textMuted}
                    strokeWidth={2.4}
                  />
                </View>
              )}
            </Pressable>
          ) : null}
        </View>
      )}
    </Pressable>
  )
}

function TabIcon({
  tab,
  hostAgentIdentity,
  active
}: {
  tab: MobileSessionTab
  hostAgentIdentity: string | undefined
  active: boolean
}) {
  const color = active ? colors.textPrimary : colors.textSecondary
  if (tab.type === 'browser') {
    return <Globe size={14} color={color} strokeWidth={2.1} />
  }
  if (tab.type === 'markdown') {
    return <FileText size={14} color={color} strokeWidth={2.1} />
  }
  if (tab.type === 'file') {
    return <File size={14} color={color} strokeWidth={2.1} />
  }
  if (tab.type === 'agent-session') {
    return <MobileAgentIcon agentId={tab.agent} size={14} />
  }
  const agentId = resolveMobileTerminalTabAgentId(tab, hostAgentIdentity)
  return agentId ? (
    <MobileAgentIcon agentId={agentId} size={14} />
  ) : (
    <SquareTerminal size={14} color={color} strokeWidth={2.1} />
  )
}

const styles = StyleSheet.create({
  touch: { height: TAB_HEIGHT },
  tab: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 14,
    borderRadius: TAB_HEIGHT / 2
  },
  tabActive: { paddingRight: 34 },
  tabPressed: { backgroundColor: 'rgba(255, 255, 255, 0.05)' },
  divider: {
    position: 'absolute',
    left: 0,
    top: 10,
    bottom: 10,
    width: 1,
    backgroundColor: 'rgba(255, 255, 255, 0.09)'
  },
  dividerHidden: { opacity: 0 },
  statusDot: { width: 7, height: 7, borderRadius: 3.5, flexShrink: 0 },
  // The page shrinks a bare svg in a row before the title's ellipsis kicks in.
  icon: { flexShrink: 0 },
  label: {
    ...textStyles.subhead,
    fontWeight: '500',
    flexShrink: 1,
    minWidth: 0,
    color: colors.textSecondary
  },
  labelActive: { color: colors.textPrimary },
  // Fills the tab's right end, so the 24 pt circle gets a 34 pt box of its own.
  closeTouch: {
    position: 'absolute',
    right: 0,
    top: 0,
    bottom: 0,
    width: 34,
    alignItems: 'center',
    justifyContent: 'center'
  },
  close: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center'
  },
  closePressed: { backgroundColor: colors.fillPressed }
})
