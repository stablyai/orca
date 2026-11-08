import { useRef } from 'react'
import { Pressable, Text, View, type LayoutChangeEvent } from 'react-native'
import { File, FileText, Globe, SquareTerminal } from 'lucide-react-native'
import { AgentStateDot } from '../components/AgentStateDot'
import { MobileAgentIcon } from '../components/MobileAgentIcon'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors } from '../theme/mobile-theme'
import { agentStateLabel, type AgentDotState } from '../worktree/agent-row-display'
import type { MobileSessionTab } from './mobile-session-route-types'
import { styles } from './mobile-session-styles'
import { resolveMobileTerminalTabAgentId } from './mobile-terminal-tab-agent'

export function MobileSessionStripTab({
  tab,
  first,
  active,
  isDragging = false,
  title,
  tabState,
  hostAgentIdentity,
  onLayout,
  onPress,
  onLongPress,
  onDragMove,
  onDragEnd
}: {
  tab: MobileSessionTab
  first: boolean
  active: boolean
  isDragging?: boolean
  title: string
  tabState: AgentDotState | undefined
  hostAgentIdentity: string | undefined
  onLayout: (event: LayoutChangeEvent) => void
  onPress: () => void
  onLongPress: () => void
  onDragMove?: (dx: number) => void
  onDragEnd?: () => void
}) {
  const t = useMobileTranslation()
  const touchStartRef = useRef<{ x: number; y: number; at: number } | null>(null)
  const draggingRef = useRef(false)

  return (
    <Pressable
      style={({ pressed }) => [
        styles.tab,
        first && styles.tabFirst,
        active && styles.tabActive,
        (pressed || isDragging) && styles.tabPressed
      ]}
      onLayout={onLayout}
      onTouchStart={(event) => {
        const touch = event.nativeEvent.touches?.[0]
        if (!touch) {
          return
        }
        touchStartRef.current = {
          x: touch.pageX,
          y: touch.pageY,
          at: Date.now()
        }
        draggingRef.current = false
      }}
      onTouchMove={(event) => {
        const start = touchStartRef.current
        const touch = event.nativeEvent.touches?.[0]
        if (!start || !touch || !onDragMove) {
          return
        }
        const dx = touch.pageX - start.x
        const dy = touch.pageY - start.y
        if (
          !draggingRef.current &&
          (active || Date.now() - start.at >= 160) &&
          Math.abs(dx) >= 14 &&
          Math.abs(dx) > Math.abs(dy) * 1.25
        ) {
          draggingRef.current = true
        }
        if (draggingRef.current) {
          onDragMove(dx)
        }
      }}
      onTouchEnd={() => {
        touchStartRef.current = null
        if (draggingRef.current) {
          draggingRef.current = false
          onDragEnd?.()
        }
      }}
      onTouchCancel={() => {
        touchStartRef.current = null
        if (draggingRef.current) {
          draggingRef.current = false
          onDragEnd?.()
        }
      }}
      onPress={() => {
        if (draggingRef.current) {
          return
        }
        onPress()
      }}
      accessibilityRole="tab"
      accessibilityLabel={
        tabState && tabState !== 'idle'
          ? t('session.tabStrip.tabStatus', '{{title}}, {{status}}', {
              title,
              status: agentStateLabel(tabState)
            })
          : title
      }
      accessibilityState={{ selected: active }}
      onLongPress={() => {
        if (draggingRef.current) {
          return
        }
        onLongPress()
      }}
      delayLongPress={400}
    >
      <View style={styles.tabLabelRow}>
        {tabState && tabState !== 'idle' ? <AgentStateDot state={tabState} /> : null}
        <View style={styles.tabIcon}>
          {tab.type === 'browser' && (
            <Globe size={13} color={colors.textSecondary} strokeWidth={2.1} />
          )}
          {tab.type === 'markdown' && (
            <FileText size={13} color={colors.textSecondary} strokeWidth={2.1} />
          )}
          {tab.type === 'file' && (
            <File size={13} color={colors.textSecondary} strokeWidth={2.1} />
          )}
          {tab.type === 'agent-session' && <MobileAgentIcon agentId={tab.agent} size={13} />}
          {tab.type === 'terminal' &&
            (() => {
              const agentId = resolveMobileTerminalTabAgentId(tab, hostAgentIdentity)
              return agentId ? (
                <MobileAgentIcon agentId={agentId} size={13} />
              ) : (
                <SquareTerminal size={13} color={colors.textSecondary} strokeWidth={2.1} />
              )
            })()}
        </View>
        <Text style={[styles.tabText, active && styles.tabTextActive]} numberOfLines={1}>
          {title}
        </Text>
      </View>
    </Pressable>
  )
}
