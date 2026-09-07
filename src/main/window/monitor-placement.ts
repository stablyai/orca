export type WindowPlacement = { x: number; y: number; width: number; height: number }

export type MonitorDisplay = {
  id: number
  scaleFactor: number
  workArea: WindowPlacement
}

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
