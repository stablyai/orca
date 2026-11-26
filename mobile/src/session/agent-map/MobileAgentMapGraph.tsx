import { useMemo } from 'react'
import { Circle, G, Path, Rect, Svg, Text as SvgText } from 'react-native-svg'
import {
  AGENT_MAP_ROOT_ID,
  type AgentMap,
  type AgentMapNode,
  type AgentMapNodeStatus,
  type AgentMapViewState
} from '../../../../src/shared/agent-session-map/agent-session-map-model'
import type { AgentMapLayout } from '../../../../src/shared/agent-session-map/agent-session-map-layout'
import { agentMapToolChipsAt } from '../../../../src/shared/agent-session-map/agent-session-map-tool-chips'
import type { Translate } from '../../i18n/mobile-i18n'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { colors, typography } from '../../theme/mobile-theme'

export const AGENT_MAP_NODE_WIDTH = 150
export const AGENT_MAP_NODE_HEIGHT = 52
export const AGENT_MAP_CHIP_ROW_HEIGHT = 18

// Palette reads stay inside the function so a scheme change re-themes the map.
function statusColors(status: AgentMapNodeStatus): { stroke: string; fill: string } {
  switch (status) {
    case 'running':
      return { stroke: colors.accentBlue, fill: 'rgba(59, 130, 246, 0.14)' }
    case 'waiting':
      return { stroke: colors.statusAmber, fill: 'rgba(234, 179, 8, 0.14)' }
    case 'done':
      return { stroke: colors.statusGreen, fill: 'rgba(134, 239, 172, 0.12)' }
    case 'failed':
      return { stroke: colors.statusRed, fill: 'rgba(255, 101, 104, 0.14)' }
    case 'idle':
    case 'unknown':
      return { stroke: colors.textMuted, fill: colors.bgRaised }
  }
}

function statusLabel(status: AgentMapNodeStatus, t: Translate): string {
  switch (status) {
    case 'running':
      return t('session.agentMap.status.running', 'Running')
    case 'waiting':
      return t('session.agentMap.status.waiting', 'Waiting')
    case 'done':
      return t('session.agentMap.status.done', 'Done')
    case 'idle':
      return t('session.agentMap.status.idle', 'Idle')
    case 'failed':
      return t('session.agentMap.status.failed', 'Failed')
    case 'unknown':
      return t('session.agentMap.status.unknown', 'Unknown')
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function edgePath(
  from: { x: number; y: number },
  to: { x: number; y: number },
  fromHeight: number,
  toHeight: number
): string {
  const startY = from.y + fromHeight / 2
  const endY = to.y - toHeight / 2
  const midY = (startY + endY) / 2
  return `M ${from.x} ${startY} C ${from.x} ${midY}, ${to.x} ${midY}, ${to.x} ${endY}`
}

/** The zoetrope-style node graph: the main agent, its sub-agents and their tool
 *  chips, with a selection ring on the tapped node. */
export function MobileAgentMapGraph(args: {
  map: AgentMap
  layout: AgentMapLayout
  viewState: AgentMapViewState
  selectedNodeId: string | null
  onSelectNode: (id: string) => void
}): React.JSX.Element {
  const { map, layout, viewState, selectedNodeId, onSelectNode } = args
  const t = useMobileTranslation()
  const nodeById = useMemo(() => new Map(map.nodes.map((node) => [node.id, node])), [map])
  const viewById = useMemo(
    () => new Map(viewState.nodes.map((node) => [node.nodeId, node])),
    [viewState]
  )
  return (
    <Svg
      width={layout.width}
      height={layout.height}
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      accessibilityLabel={t('session.agentMap.graph.ariaLabel', 'Agent session map')}
      accessibilityRole="image"
    >
      <G>
        {layout.edges
          .filter((edge) => viewById.has(edge.fromId) && viewById.has(edge.toId))
          .map((edge) => (
            <Path
              key={`${edge.fromId}-${edge.toId}`}
              d={edgePath(edge.from, edge.to, edge.fromHeight, edge.toHeight)}
              fill="none"
              stroke={statusColors(viewById.get(edge.toId)?.status ?? 'unknown').stroke}
              strokeOpacity={0.45}
              strokeWidth={1.5}
            />
          ))}
      </G>
      <G>
        {[...layout.positions.entries()].map(([id, position]) => {
          const view = viewById.get(id)
          const node = nodeById.get(id)
          if (!view || !node) {
            return null
          }
          return (
            <MapNode
              key={id}
              x={position.x}
              y={position.y}
              node={node}
              ts={viewState.ts}
              label={node.label}
              status={view.status}
              activeTool={
                view.activeTool
                  ? `${view.activeTool.name}${view.activeTool.summary ? ` · ${view.activeTool.summary}` : ''}`
                  : undefined
              }
              waitingOn={view.waitingOn}
              isRoot={id === AGENT_MAP_ROOT_ID}
              selected={id === selectedNodeId}
              onSelect={() => onSelectNode(id)}
            />
          )
        })}
      </G>
    </Svg>
  )
}

function MapNode(args: {
  x: number
  y: number
  node: AgentMapNode
  ts: number
  label: string
  status: AgentMapNodeStatus
  activeTool?: string
  waitingOn?: string
  isRoot: boolean
  selected: boolean
  onSelect: () => void
}): React.JSX.Element {
  const { x, y, node, ts, label, status, activeTool, waitingOn, isRoot, selected, onSelect } = args
  const t = useMobileTranslation()
  const color = statusColors(status)
  const subtitle =
    status === 'running' && activeTool
      ? activeTool
      : status === 'waiting' && waitingOn
        ? t('session.agentMap.node.waitingOn', 'Waiting on {{target}}', { target: waitingOn })
        : isRoot
          ? t('session.agentMap.node.mainAgent', 'Main agent')
          : statusLabel(status, t)
  const chips = agentMapToolChipsAt(node.toolCalls, ts)
  return (
    <G
      transform={`translate(${x - AGENT_MAP_NODE_WIDTH / 2}, ${y - AGENT_MAP_NODE_HEIGHT / 2})`}
      onPress={onSelect}
      // No accessibilityRole="button": react-native-web would swap the SVG `g`
      // for a `button`, which is not an SVG graphics container.
      accessibilityLabel={`${label} — ${statusLabel(status, t)}`}
    >
      {selected && (
        <Rect
          x={-3}
          y={-3}
          width={AGENT_MAP_NODE_WIDTH + 6}
          height={AGENT_MAP_NODE_HEIGHT + 6}
          rx={15}
          fill="none"
          stroke={colors.accentBlue}
          strokeWidth={2}
        />
      )}
      <Rect
        width={AGENT_MAP_NODE_WIDTH}
        height={AGENT_MAP_NODE_HEIGHT}
        rx={12}
        fill={color.fill}
        stroke={color.stroke}
        strokeWidth={status === 'running' || status === 'waiting' ? 2 : 1.25}
      />
      <Circle cx={16} cy={20} r={5} fill={color.stroke} />
      <SvgText x={30} y={24} fill={colors.textPrimary} fontSize={13} fontWeight="600">
        {truncate(label, 16)}
      </SvgText>
      <SvgText x={16} y={42} fill={colors.textSecondary} fontSize={11}>
        {truncate(subtitle, 28)}
      </SvgText>
      {chips.slice(0, 2).map((chip, i) => {
        const extra = i === 1 && chips.length > 2 ? ` +${chips.length - 2}` : ''
        return (
          <SvgText
            key={chip.name}
            x={16 + i * 64}
            y={AGENT_MAP_NODE_HEIGHT + 13}
            fontSize={9}
            fontFamily={typography.monoFamily}
            fill={
              chip.failed > 0
                ? colors.statusRed
                : chip.running > 0
                  ? colors.accentBlue
                  : colors.textMuted
            }
          >
            {truncate(chip.name, 8)} ×{chip.count}
            {chip.failed > 0 ? ' ✗' : ''}
            {chip.running > 0 ? ' ●' : ''}
            {extra}
          </SvgText>
        )
      })}
    </G>
  )
}
