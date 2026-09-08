export type WindowPlacement = { x: number; y: number; width: number; height: number }

export type MonitorDisplay = {
  id: number
  scaleFactor: number
  workArea: WindowPlacement
}

const TILE_GAP = 12
const TITLEBAR_HEIGHT = 48
const MIN_REACHABLE_TITLEBAR_WIDTH = 96

function overlap(startA: number, lengthA: number, startB: number, lengthB: number): number {
  return Math.max(0, Math.min(startA + lengthA, startB + lengthB) - Math.max(startA, startB))
}

function hasReachableTitlebar(rect: WindowPlacement, display: MonitorDisplay): boolean {
  return (
    overlap(rect.x, rect.width, display.workArea.x, display.workArea.width) >=
      Math.min(MIN_REACHABLE_TITLEBAR_WIDTH, display.workArea.width, rect.width) &&
    overlap(rect.y, TITLEBAR_HEIGHT, display.workArea.y, display.workArea.height) >=
      Math.min(TITLEBAR_HEIGHT, display.workArea.height)
  )
}

function distanceToWorkArea(rect: WindowPlacement, display: MonitorDisplay): number {
  const centerX = rect.x + rect.width / 2
  const centerY = rect.y + TITLEBAR_HEIGHT / 2
  const area = display.workArea
  const dx = Math.max(area.x - centerX, 0, centerX - (area.x + area.width))
  const dy = Math.max(area.y - centerY, 0, centerY - (area.y + area.height))
  return dx * dx + dy * dy
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

export function recoverWindowPlacement(
  rect: WindowPlacement,
  displays: readonly MonitorDisplay[]
): WindowPlacement {
  const usableDisplays = displays.filter((display) => isValidWindowPlacement(display.workArea))
  if (
    !isValidWindowPlacement(rect) ||
    usableDisplays.length === 0 ||
    usableDisplays.some((display) => hasReachableTitlebar(rect, display))
  ) {
    return rect
  }

  const target = usableDisplays.reduce((nearest, display) =>
    distanceToWorkArea(rect, display) < distanceToWorkArea(rect, nearest) ? display : nearest
  )
  const area = target.workArea
  const maxX = area.x + Math.max(0, area.width - rect.width)
  const maxY = area.y + Math.max(0, area.height - rect.height)
  return {
    ...rect,
    x: clamp(rect.x, area.x, maxX),
    y: clamp(rect.y, area.y, maxY)
  }
}

export function isValidWindowPlacement(rect: WindowPlacement): boolean {
  return (
    [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) &&
    rect.width > 0 &&
    rect.height > 0
  )
}

export function readMonitorDisplays(
  read: () => readonly MonitorDisplay[]
): readonly MonitorDisplay[] {
  try {
    return read()
  } catch {
    return []
  }
}

function gridShape(count: number): { columns: number; rows: number } {
  const columns = Math.max(1, Math.ceil(Math.sqrt(count)))
  return { columns, rows: Math.max(1, Math.ceil(count / columns)) }
}

function gridCell(
  area: WindowPlacement,
  index: number,
  count: number,
  gap: number
): WindowPlacement {
  const { columns, rows } = gridShape(count)
  const columnGap = Math.min(gap, Math.max(0, Math.floor(area.width / (columns + 1))))
  const rowGap = Math.min(gap, Math.max(0, Math.floor(area.height / (rows + 1))))
  const width = Math.max(1, Math.floor((area.width - columnGap * (columns + 1)) / columns))
  const height = Math.max(1, Math.floor((area.height - rowGap * (rows + 1)) / rows))
  const column = index % columns
  const row = Math.floor(index / columns)
  return {
    x: area.x + columnGap + column * (width + columnGap),
    y: area.y + rowGap + row * (height + rowGap),
    width,
    height
  }
}

export function tileWindowPlacements(
  display: MonitorDisplay,
  count: number,
  gap = TILE_GAP
): WindowPlacement[] {
  if (count <= 0 || !isValidWindowPlacement(display.workArea)) {
    return []
  }
  return Array.from({ length: count }, (_, index) =>
    gridCell(display.workArea, index, count, Math.max(0, gap))
  )
}

export function distributeWindowPlacements(
  displays: readonly MonitorDisplay[],
  count: number,
  gap = TILE_GAP
): WindowPlacement[] {
  const usableDisplays = displays.filter((display) => isValidWindowPlacement(display.workArea))
  if (count <= 0 || usableDisplays.length === 0) {
    return []
  }
  const groups = usableDisplays.map(() => [] as number[])
  for (let index = 0; index < count; index += 1) {
    groups[index % usableDisplays.length].push(index)
  }
  const placements = Array<WindowPlacement>(count)
  for (const [displayIndex, indexes] of groups.entries()) {
    indexes.forEach((windowIndex, gridIndex) => {
      placements[windowIndex] = gridCell(
        usableDisplays[displayIndex].workArea,
        gridIndex,
        indexes.length,
        Math.max(0, gap)
      )
    })
  }
  return placements
}
