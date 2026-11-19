import { useMemo, useState } from 'react'
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type GestureResponderEvent
} from 'react-native'
import { X } from 'lucide-react-native'
import { buildAgentSessionMap } from '../../../../src/shared/agent-session-map/build-agent-session-map'
import type {
  AgentMap,
  AgentMapViewState
} from '../../../../src/shared/agent-session-map/agent-session-map-model'
import { mapStateAt } from '../../../../src/shared/agent-session-map/agent-session-map-playhead'
import { layoutAgentMap } from '../../../../src/shared/agent-session-map/agent-session-map-layout'
import { agentMapSessionSummary } from '../../../../src/shared/agent-session-map/agent-session-map-session-summary'
import { MobileAgentMapDetail } from './MobileAgentMapDetail'
import {
  MobileAgentMapGraph,
  AGENT_MAP_NODE_WIDTH,
  AGENT_MAP_NODE_HEIGHT,
  AGENT_MAP_CHIP_ROW_HEIGHT
} from './MobileAgentMapGraph'
import { encodeNativeChatTranscriptIdentity } from '../../../../src/shared/native-chat/transcript/messages/native-chat-transcript-retention'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { colors } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { useMobileStructuredAgentState } from '../native-chat/agent-session/use-mobile-structured-agent-state'

const MIN_GRAPH_WIDTH = 320

/** The switchable live map of the active agent session (zoetrope-style): a node
 *  graph of the main agent, its sub-agents and their tools, plus a time scrubber. */
export function MobileAgentMapView(args: {
  client: RpcClient | null
  connected: boolean
  agent: string | null
  sessionId: string | null
  sourceIdentity: string
  onClose: () => void
}): React.JSX.Element {
  const { client, connected, agent, sessionId, sourceIdentity, onClose } = args
  const t = useMobileTranslation()
  const sessionKey =
    sessionId != null
      ? encodeNativeChatTranscriptIdentity([sourceIdentity, agent ?? '', sessionId])
      : null
  const { state } = useMobileStructuredAgentState({
    client,
    sessionId,
    sessionKey,
    enabled: sessionId != null,
    connected
  })
  const [playheadTs, setPlayheadTs] = useState<number | null>(null)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [width, setWidth] = useState(0)
  const [trackWidth, setTrackWidth] = useState(0)

  const map: AgentMap | null = useMemo(
    () => (state.items.length > 0 ? buildAgentSessionMap(state.items) : null),
    [state.items]
  )
  const graphWidth = width > 0 ? Math.max(width, MIN_GRAPH_WIDTH) : MIN_GRAPH_WIDTH
  const layout = useMemo(
    () =>
      map
        ? layoutAgentMap(map, graphWidth, {
            nodeWidth: AGENT_MAP_NODE_WIDTH,
            nodeHeight: AGENT_MAP_NODE_HEIGHT,
            chipRowHeight: AGENT_MAP_CHIP_ROW_HEIGHT
          })
        : null,
    [graphWidth, map]
  )
  const viewState: AgentMapViewState | null = useMemo(
    () => (map ? mapStateAt(map, playheadTs) : null),
    [map, playheadTs]
  )
  const summary = useMemo(() => (map ? agentMapSessionSummary(map) : null), [map])
  const selectedNode =
    selectedNodeId !== null && map
      ? map.nodes.find((node) => node.id === selectedNodeId)
      : undefined
  const selectedView =
    selectedNode && viewState
      ? viewState.nodes.find((node) => node.nodeId === selectedNode.id)
      : undefined

  const timeline = map?.timeline ?? []
  const lastIndex = timeline.length - 1
  const isLive = playheadTs === null
  const value =
    lastIndex < 0 ? 0 : isLive ? lastIndex : nearestIndexAtOrBefore(timeline, playheadTs)
  const thumbX = lastIndex < 0 || trackWidth <= 0 ? 0 : (value / lastIndex) * trackWidth

  const scrubAt = (locationX: number): void => {
    if (lastIndex < 0 || trackWidth <= 0) {
      return
    }
    const ratio = Math.min(1, Math.max(0, locationX / trackWidth))
    const index = Math.round(ratio * lastIndex)
    setPlayheadTs(index >= lastIndex ? null : (timeline[index]?.ts ?? null))
  }

  return (
    <View style={styles.overlay}>
      <View style={styles.header}>
        <Text style={styles.title} numberOfLines={1}>
          {t('session.agentMap.title', 'Agent Map')}
        </Text>
        {map && (
          <Text style={styles.count} numberOfLines={1}>
            {t('session.agentMap.agents.count', '{{count}} agents', {
              count: map.nodes.length
            })}
            {summary && (
              <>
                {' · '}
                {t('session.agentMap.session.tools', '{{count}} tools', {
                  count: summary.toolCallCount
                })}
                {' · '}
                {t('session.agentMap.session.files', '{{count}} files', {
                  count: summary.filesTouched.length
                })}
              </>
            )}
          </Text>
        )}
        <Pressable
          hitSlop={12}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel={t('common.close', 'Close')}
        >
          <X size={18} color={colors.textSecondary} />
        </Pressable>
      </View>
      <ScrollView
        style={styles.graphScroll}
        contentContainerStyle={styles.graphContent}
        onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
        alwaysBounceVertical={false}
      >
        {map && layout && viewState ? (
          <MobileAgentMapGraph
            map={map}
            layout={layout}
            viewState={viewState}
            selectedNodeId={selectedNodeId}
            onSelectNode={(id) => setSelectedNodeId((prev) => (prev === id ? null : id))}
          />
        ) : (
          <Text style={styles.empty}>
            {t('session.agentMap.empty', 'No agent session in this pane')}
          </Text>
        )}
      </ScrollView>
      {map && (
        <View style={styles.scrubber}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: isLive }}
            onPress={() => setPlayheadTs(null)}
            style={[styles.liveButton, isLive && styles.liveButtonActive]}
          >
            <Text style={[styles.liveText, isLive && styles.liveTextActive]}>
              {isLive
                ? `● ${t('session.agentMap.timeline.live', 'Live')}`
                : t('session.agentMap.timeline.live', 'Live')}
            </Text>
          </Pressable>
          <View style={styles.trackColumn}>
            {lastIndex > 0 && (
              <View style={styles.markerRow} pointerEvents="none">
                {timeline.map((event, i) => (
                  <View
                    key={`${event.seq}-${event.kind}`}
                    style={[
                      styles.marker,
                      { left: `${(i / lastIndex) * 100}%`, backgroundColor: markerColor(event) }
                    ]}
                  />
                ))}
              </View>
            )}
            <View
              style={styles.track}
              onStartShouldSetResponder={() => true}
              onResponderGrant={(event: GestureResponderEvent) =>
                scrubAt(event.nativeEvent.locationX)
              }
              onResponderMove={(event: GestureResponderEvent) =>
                scrubAt(event.nativeEvent.locationX)
              }
              onLayout={(event) => setTrackWidth(event.nativeEvent.layout.width)}
            >
              <View style={[styles.trackFill, { width: thumbX }]} />
              <View style={[styles.thumb, { left: thumbX - 8 }]} />
            </View>
          </View>
          <Text style={styles.counter}>
            {lastIndex < 0 ? '—' : `${value + 1}/${lastIndex + 1}`}
          </Text>
        </View>
      )}
      {selectedNode && selectedView && (
        <MobileAgentMapDetail
          node={selectedNode}
          view={selectedView}
          onClose={() => setSelectedNodeId(null)}
        />
      )}
    </View>
  )
}

/** Ticks mark the moments worth scrubbing to: prompts, spawns, questions, failures. */
function markerColor(event: AgentMap['timeline'][number]): string {
  if (event.failed) {
    return colors.statusRed
  }
  if (event.kind === 'prompt' || event.kind === 'agent-spawn') {
    return colors.accentBlue
  }
  if (event.kind === 'question' || event.kind === 'approval') {
    return colors.statusAmber
  }
  return colors.borderSubtle
}

function nearestIndexAtOrBefore(timeline: AgentMap['timeline'], ts: number | null): number {
  if (ts == null) {
    return timeline.length - 1
  }
  let index = 0
  for (let i = 0; i < timeline.length; i++) {
    if (timeline[i]?.ts <= ts) {
      index = i
    } else {
      break
    }
  }
  return index
}

const styles = themedStyleSheet(() => ({
  overlay: {
    ...StyleSheet.absoluteFill,
    backgroundColor: colors.bgBase,
    flexDirection: 'column'
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle
  },
  title: {
    color: colors.textPrimary,
    fontSize: 15,
    fontWeight: '600',
    flexShrink: 1
  },
  count: {
    color: colors.textMuted,
    fontSize: 12,
    flexShrink: 1
  },
  graphScroll: { flex: 1 },
  graphContent: { alignItems: 'center', justifyContent: 'center', padding: 16 },
  empty: { color: colors.textMuted, fontSize: 14, padding: 24 },
  scrubber: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: colors.borderSubtle
  },
  liveButton: {
    backgroundColor: colors.bgRaised,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4
  },
  liveButtonActive: { backgroundColor: colors.accentBlue },
  liveText: { color: colors.textSecondary, fontSize: 12, fontWeight: '500' },
  liveTextActive: { color: colors.onAccent },
  trackColumn: {
    flex: 1,
    gap: 4
  },
  markerRow: {
    height: 4,
    justifyContent: 'center'
  },
  marker: {
    position: 'absolute',
    top: 0,
    width: 1.5,
    height: 4
  },
  track: {
    height: 20,
    justifyContent: 'center'
  },
  trackFill: {
    position: 'absolute',
    left: 0,
    top: 8,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.accentBlue
  },
  thumb: {
    position: 'absolute',
    top: 2,
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: colors.accentBlue
  },
  counter: { color: colors.textMuted, fontSize: 12, minWidth: 44, textAlign: 'right' }
}))
