import { useMemo, useRef } from 'react'
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native'
import Svg, { Line } from 'react-native-svg'
import {
  workspaceSurfaceKey,
  type WorkspaceSurface
} from '../../../src/shared/maestro-workspace-canvas'
import type { RpcClient } from '../transport/rpc-client'
import { colors } from '../theme/mobile-theme'
import {
  projectMobileMaestroFrame,
  type MaestroCardFrame,
  type MaestroViewport
} from './mobile-maestro-geometry'
import { mobileMaestroScreenStyles as styles } from './mobile-maestro-screen-styles'
import { MobileMaestroSurfaceCard } from './MobileMaestroSurfaceCard'
import { useMobileMaestroGestures } from './use-mobile-maestro-gestures'

type BoardLink = {
  id: string
  source_surface_key: string
  target_surface_key: string
  provenance: 'manual' | 'automatic' | 'suggested'
}

const GRID_WORLD_SPACING = 40
const MINIMUM_GRID_SCREEN_SPACING = 8

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor
}

function MobileMaestroGrid({
  viewport,
  width,
  height
}: {
  viewport: MaestroViewport
  width: number
  height: number
}): React.JSX.Element {
  const spacing = Math.max(MINIMUM_GRID_SCREEN_SPACING, GRID_WORLD_SPACING * viewport.zoom)
  const offsetX = positiveModulo(width / 2 - viewport.center.x * viewport.zoom, spacing)
  const offsetY = positiveModulo(height / 2 - viewport.center.y * viewport.zoom, spacing)
  const verticalCount = Math.ceil(width / spacing) + 2
  const horizontalCount = Math.ceil(height / spacing) + 2

  return (
    <Svg width={width} height={height} style={StyleSheet.absoluteFill} pointerEvents="none">
      {Array.from({ length: verticalCount }, (_, index) => {
        const x = offsetX + (index - 1) * spacing
        return (
          <Line
            key={`grid-v-${index}`}
            x1={x}
            y1={0}
            x2={x}
            y2={height}
            stroke={colors.borderSubtle}
            strokeWidth={0.5}
            opacity={0.45}
          />
        )
      })}
      {Array.from({ length: horizontalCount }, (_, index) => {
        const y = offsetY + (index - 1) * spacing
        return (
          <Line
            key={`grid-h-${index}`}
            x1={0}
            y1={y}
            x2={width}
            y2={y}
            stroke={colors.borderSubtle}
            strokeWidth={0.5}
            opacity={0.45}
          />
        )
      })}
    </Svg>
  )
}

export function MobileMaestroBoard({
  surfaces,
  frames,
  viewport,
  viewportWidth,
  viewportHeight,
  links,
  selectedKey,
  previews,
  client,
  worktreeId,
  onSelect,
  onViewportLayout,
  onViewportChange
}: {
  surfaces: WorkspaceSurface[]
  frames: MaestroCardFrame[]
  viewport: MaestroViewport
  viewportWidth: number
  viewportHeight: number
  links: BoardLink[]
  selectedKey: string | null
  previews: Record<string, string>
  client: RpcClient | null
  worktreeId: string | null
  onSelect: (key: string) => void
  onViewportLayout: (size: { width: number; height: number }) => void
  onViewportChange: (viewport: MaestroViewport) => void
}) {
  const boardRef = useRef<View>(null)
  const viewportOriginRef = useRef({ x: 0, y: 0 })
  const panResponder = useMobileMaestroGestures({
    viewport,
    viewportSize: { width: viewportWidth, height: viewportHeight },
    viewportOriginRef,
    onViewportChange
  })
  const frameByKey = useMemo(
    () =>
      new Map(surfaces.map((surface, index) => [workspaceSurfaceKey(surface.id), frames[index]!])),
    [frames, surfaces]
  )
  const featuredSurfaceKey =
    selectedKey ??
    surfaces
      .filter((surface) => surface.binding.kind === 'terminal')
      .map((surface) => workspaceSurfaceKey(surface.id))[0] ??
    (surfaces[0] ? workspaceSurfaceKey(surfaces[0].id) : null)
  return (
    <View
      ref={boardRef}
      testID="mobile-maestro-board"
      style={styles.board}
      onLayout={(event: LayoutChangeEvent) => {
        onViewportLayout(event.nativeEvent.layout)
        boardRef.current?.measureInWindow((x, y) => {
          viewportOriginRef.current = { x, y }
        })
      }}
      {...panResponder.panHandlers}
    >
      <MobileMaestroGrid viewport={viewport} width={viewportWidth} height={viewportHeight} />
      <Svg
        width={viewportWidth}
        height={viewportHeight}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      >
        {links.map((link) => {
          const source = frameByKey.get(link.source_surface_key)
          const target = frameByKey.get(link.target_surface_key)
          if (!source || !target) {
            return null
          }
          const projectedSource = projectMobileMaestroFrame(viewport, source, {
            width: viewportWidth,
            height: viewportHeight
          })
          const projectedTarget = projectMobileMaestroFrame(viewport, target, {
            width: viewportWidth,
            height: viewportHeight
          })
          return (
            <Line
              key={`${link.provenance}:${link.id}`}
              x1={projectedSource.x + projectedSource.width / 2}
              y1={projectedSource.y + projectedSource.height / 2}
              x2={projectedTarget.x + projectedTarget.width / 2}
              y2={projectedTarget.y + projectedTarget.height / 2}
              stroke={
                link.provenance === 'suggested'
                  ? colors.statusAmber
                  : link.provenance === 'automatic'
                    ? colors.textMuted
                    : colors.textSecondary
              }
              strokeWidth={link.provenance === 'manual' ? 2 : 1.5}
              strokeDasharray={link.provenance === 'suggested' ? '6 6' : undefined}
            />
          )
        })}
      </Svg>
      {surfaces.map((surface, index) => {
        const frame = frames[index]!
        const key = workspaceSurfaceKey(surface.id)
        const projected = projectMobileMaestroFrame(viewport, frame, {
          width: viewportWidth,
          height: viewportHeight
        })
        return (
          <View
            key={key}
            style={{
              position: 'absolute',
              left: projected.x,
              top: projected.y,
              width: Math.max(104, projected.width),
              height: Math.max(72, projected.height),
              overflow: 'hidden'
            }}
          >
            <MobileMaestroSurfaceCard
              surface={surface}
              selected={selectedKey === key}
              preview={previews[key]}
              client={client}
              worktreeId={worktreeId}
              livePreview={featuredSurfaceKey === key}
              onPress={() => onSelect(key)}
            />
          </View>
        )
      })}
    </View>
  )
}
