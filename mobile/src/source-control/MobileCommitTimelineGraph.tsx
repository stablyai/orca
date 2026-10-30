import { View } from 'react-native'
import Svg, { Circle, ClipPath, Defs, G, Path, Rect } from 'react-native-svg'
import type {
  GitHistoryGraphNode,
  GitHistoryItemViewModel
} from '../../../src/shared/git-history-graph'
import {
  gitHistoryGraphWidth,
  layoutGitHistoryGraphRow
} from '../../../src/shared/git-history-graph-layout'
import { colors } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'

export type MobileTimelineNodeKind = 'uncommitted' | 'unpushed' | 'pushed' | 'base'

// Lane 0 sits 32pt from the row edge; the node is 22pt down, level with the title.
const GEOMETRY = { laneWidth: 16, rowHeight: 44, curveRadius: 8 }
const NODE_Y = GEOMETRY.rowHeight / 2
export const TIMELINE_GRAPH_LEFT = 16
const STROKE_WIDTH = 1.5
const LINE_OPACITY = 0.35

export function timelineGraphWidth(laneCount: number): number {
  return gitHistoryGraphWidth(laneCount, GEOMETRY.laneWidth)
}

// Straight lane segments are plain views, so a row mounts at most one SVG.
function PassThroughLanes({ lanes }: { lanes: readonly GitHistoryGraphNode[] }) {
  if (lanes.length === 0) {
    return null
  }
  return (
    <View style={styles.fill}>
      {lanes
        .map((_, index) => GEOMETRY.laneWidth * (index + 1))
        .map((x) => (
          <View key={x} style={[styles.lane, { left: x - STROKE_WIDTH / 2 }]} />
        ))}
    </View>
  )
}

function TimelineNode({ kind, cx }: { kind: MobileTimelineNodeKind; cx: number }) {
  switch (kind) {
    case 'unpushed':
      return (
        <Circle
          cx={cx}
          cy={NODE_Y}
          r={7}
          fill={colors.bgBase}
          stroke={colors.accentBlue}
          strokeWidth={2}
        />
      )
    case 'pushed':
      return (
        <Circle
          cx={cx}
          cy={NODE_Y}
          r={6}
          fill={colors.textMuted}
          stroke={colors.bgBase}
          strokeWidth={3}
        />
      )
    case 'base':
      return (
        <Rect
          x={cx - 5.25}
          y={NODE_Y - 5.25}
          width={10.5}
          height={10.5}
          rx={2.5}
          fill={colors.bgBase}
          stroke={colors.textMuted}
          strokeWidth={STROKE_WIDTH}
        />
      )
    case 'uncommitted':
      return (
        <G>
          <Circle
            cx={cx}
            cy={NODE_Y}
            r={7.25}
            fill={colors.bgBase}
            stroke={colors.textMuted}
            strokeWidth={STROKE_WIDTH}
          />
          <Circle cx={cx} cy={NODE_Y} r={3.5} fill={colors.textMuted} />
        </G>
      )
  }
}

// One timeline row's slice of desktop's commit graph; lanes continue below the node to the row's bottom.
export function MobileCommitTimelineNodeGraph({
  viewModel,
  kind
}: {
  viewModel: GitHistoryItemViewModel
  kind: MobileTimelineNodeKind
}) {
  const layout = layoutGitHistoryGraphRow(viewModel, GEOMETRY)
  // The base ends the timeline, so nothing continues below its node.
  const endsHere = kind === 'base'
  return (
    <View style={[styles.column, { width: layout.width }]} pointerEvents="none">
      <Svg width={layout.width} height={GEOMETRY.rowHeight}>
        {endsHere ? (
          <Defs>
            <ClipPath id="above-node">
              <Rect x={0} y={0} width={layout.width} height={NODE_Y} />
            </ClipPath>
          </Defs>
        ) : null}
        <G clipPath={endsHere ? 'url(#above-node)' : undefined}>
          {layout.paths.map((path) => (
            <Path
              key={path.key}
              d={path.d}
              fill="none"
              stroke={colors.textMuted}
              strokeOpacity={LINE_OPACITY}
              strokeWidth={STROKE_WIDTH}
              strokeLinecap="round"
            />
          ))}
        </G>
        <TimelineNode kind={kind} cx={layout.cx} />
      </Svg>
      {endsHere ? null : <PassThroughLanes lanes={viewModel.outputSwimlanes} />}
    </View>
  )
}

// Lanes running past a group or day header.
export function MobileCommitTimelineLanes({ lanes }: { lanes: readonly GitHistoryGraphNode[] }) {
  return (
    <View style={[styles.column, { width: timelineGraphWidth(lanes.length) }]} pointerEvents="none">
      <PassThroughLanes lanes={lanes} />
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  column: { position: 'absolute', top: 0, bottom: 0, left: TIMELINE_GRAPH_LEFT },
  fill: { flex: 1 },
  lane: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: STROKE_WIDTH,
    backgroundColor: colors.textMuted,
    opacity: LINE_OPACITY
  }
}))
