import { useMemo, useRef, type RefObject } from 'react'
import { View, Text, Pressable, type LayoutChangeEvent } from 'react-native'
import { File, FileText, Globe, SquareTerminal } from 'lucide-react-native'
import { DetailCardFocusBoundary } from '../components/detail-card-host'
import { useDetailCardSource, type DetailCardSource } from '../components/use-anchored-detail-card'
import { MobileAgentIcon } from '../components/MobileAgentIcon'
import { AgentStateDot } from '../components/AgentStateDot'
import { agentStateLabel, type AgentDotState } from '../worktree/agent-row-display'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors } from '../theme/mobile-theme'
import { styles } from './mobile-session-styles'
import type { SessionTitleCard } from './use-session-title-card'
import type { MobileSessionTab as SessionTab } from './mobile-session-route-types'

export function MobileSessionTab({
  tab,
  first,
  active,
  title,
  tabState,
  agentId,
  details,
  barRef,
  onLayout,
  onPress,
  onLongPress
}: {
  tab: SessionTab
  first: boolean
  active: boolean
  title: string
  tabState?: AgentDotState
  agentId: string | null
  details: SessionTitleCard['tabDetails']
  barRef: RefObject<View | null>
  onLayout: (event: LayoutChangeEvent) => void
  onPress: (source: DetailCardSource) => void
  onLongPress: () => void
}) {
  const t = useMobileTranslation()
  const openerRef = useRef<View>(null)
  const source = useMemo<DetailCardSource>(
    () => ({ key: `tab:${tab.id}`, anchorRef: openerRef, openerRef, barRef, geometry: 'refresh' }),
    [tab.id, barRef]
  )
  useDetailCardSource(details, source)
  const ownsCard = details.activeKey === source.key
  return (
    <>
      <DetailCardFocusBoundary refs={details.boundaryRefs} index={0} active={ownsCard} />
      <Pressable
        ref={openerRef}
        style={[styles.tab, first && styles.tabFirst, active && styles.tabActive]}
        onLayout={(event) => {
          onLayout(event)
          details.refreshSource()
        }}
        onPress={() => onPress(source)}
        accessibilityRole="tab"
        aria-expanded={details.requestedKey === source.key}
        accessibilityLabel={
          tabState && tabState !== 'idle'
            ? t('session.tabStrip.tabStatus', '{{title}}, {{status}}', {
                title,
                status: agentStateLabel(tabState)
              })
            : title
        }
        accessibilityState={{ selected: active }}
        onLongPress={onLongPress}
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
            {agentId ? (
              <MobileAgentIcon agentId={agentId} size={13} />
            ) : tab.type === 'terminal' ? (
              <SquareTerminal size={13} color={colors.textSecondary} strokeWidth={2.1} />
            ) : null}
          </View>
          <Text style={[styles.tabText, active && styles.tabTextActive]} numberOfLines={1}>
            {title}
          </Text>
        </View>
      </Pressable>
      <DetailCardFocusBoundary refs={details.boundaryRefs} index={1} active={ownsCard} />
    </>
  )
}
