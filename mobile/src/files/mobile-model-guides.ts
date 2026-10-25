// Ported from the desktop's src/renderer/src/components/editor/glb-scene-guides.ts (not imported,
// like the rest of the mobile bundle).
import {
  type Box3,
  BufferGeometry,
  Float32BufferAttribute,
  GridHelper,
  Group,
  LineBasicMaterial,
  LineSegments,
  Vector3
} from 'three'

export type MobileModelDimensions = {
  width: number
  height: number
  depth: number
}

export type MobileModelGuides = {
  group: Group
  dimensions: MobileModelDimensions
  /** Edge length of one grid cell, in glTF units (meters). */
  gridCellSize: number
  dispose: () => void
}

const GRID_COLOR = 0x888888
const GRID_OPACITY = 0.35
const MAX_GRID_DIVISIONS = 40
const AXIS_COLORS = [
  [1, 0.2, 0.2],
  [0.3, 0.85, 0.3],
  [0.25, 0.5, 1]
] as const

export type AxisSegment = { from: [number, number, number]; to: [number, number, number] }

/**
 * X and Z run across the whole floor through the origin and Y rises as tall as the floor is wide,
 * like Blender's floor axes: a model built around its origin would otherwise hide short axes inside it.
 */
export function axisSegmentsFor(
  gridCenterX: number,
  gridCenterZ: number,
  halfSize: number
): AxisSegment[] {
  const span = (center: number): [number, number] => [
    Math.min(center - halfSize, 0),
    Math.max(center + halfSize, 0)
  ]
  const [xMin, xMax] = span(gridCenterX)
  const [zMin, zMax] = span(gridCenterZ)
  return [
    { from: [xMin, 0, 0], to: [xMax, 0, 0] },
    { from: [0, 0, 0], to: [0, halfSize * 2, 0] },
    { from: [0, 0, zMin], to: [0, 0, zMax] }
  ]
}

function createAxisLines(segments: AxisSegment[]): { lines: LineSegments; dispose: () => void } {
  const geometry = new BufferGeometry()
  geometry.setAttribute(
    'position',
    new Float32BufferAttribute(
      segments.flatMap((segment) => [...segment.from, ...segment.to]),
      3
    )
  )
  geometry.setAttribute(
    'color',
    new Float32BufferAttribute(
      segments.flatMap((_, index) => [...AXIS_COLORS[index], ...AXIS_COLORS[index]]),
      3
    )
  )
  // Why: tone mapping would wash the axis colors out toward gray.
  const material = new LineBasicMaterial({ vertexColors: true, toneMapped: false })
  const lines = new LineSegments(geometry, material)
  // Why: drawn after the faded grid so the axes win where they overlap its center lines.
  lines.renderOrder = 1
  return {
    lines,
    dispose: () => {
      geometry.dispose()
      material.dispose()
    }
  }
}

/** A power of ten roughly a tenth of the model's largest extent. */
export function gridCellSizeFor(largestExtent: number): number {
  return 10 ** Math.floor(Math.log10(Math.max(largestExtent, 1e-6) / 2))
}

function fadeGrid(grid: GridHelper): void {
  const materials = Array.isArray(grid.material) ? grid.material : [grid.material]
  for (const material of materials) {
    material.transparent = true
    material.opacity = GRID_OPACITY
    material.depthWrite = false
  }
}

/** A floor grid at y = 0 under the model and axes at the world origin, so scale and orientation read at a glance. */
export function createMobileModelGuides(bounds: Box3): MobileModelGuides {
  const size = bounds.getSize(new Vector3())
  const center = bounds.getCenter(new Vector3())
  const largestExtent = Math.max(size.x, size.y, size.z)
  const cell = gridCellSizeFor(largestExtent)
  const divisions = Math.min(
    MAX_GRID_DIVISIONS,
    2 * Math.ceil(Math.max(size.x, size.z, largestExtent) / cell)
  )
  const grid = new GridHelper(cell * divisions, divisions, GRID_COLOR, GRID_COLOR)
  fadeGrid(grid)
  // Why: snap to the cell size so grid lines stay on whole world coordinates under an off-origin model.
  grid.position.set(Math.round(center.x / cell) * cell, 0, Math.round(center.z / cell) * cell)

  const axes = createAxisLines(
    axisSegmentsFor(grid.position.x, grid.position.z, (cell * divisions) / 2)
  )
  const group = new Group()
  group.add(grid, axes.lines)
  return {
    group,
    dimensions: { width: size.x, height: size.y, depth: size.z },
    gridCellSize: cell,
    dispose: () => {
      grid.dispose()
      axes.dispose()
    }
  }
}
