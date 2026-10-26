import type { DesktopAppTarget, DesktopAppWindow } from '../../shared/desktop-app-types'

// Validates the helper's `listDesktopWindows` payload instead of trusting its shape.
export function parseDesktopAppWindows(result: unknown): DesktopAppWindow[] {
  const windows = isRecord(result) && Array.isArray(result.windows) ? result.windows : []
  return windows.flatMap((entry: unknown): DesktopAppWindow[] => {
    if (!isRecord(entry) || !isRecord(entry.bounds)) {
      return []
    }
    const { windowId, pid, appName, bundleId, title, bounds } = entry
    if (
      typeof windowId !== 'number' ||
      typeof pid !== 'number' ||
      typeof appName !== 'string' ||
      typeof bounds.x !== 'number' ||
      typeof bounds.y !== 'number' ||
      typeof bounds.width !== 'number' ||
      typeof bounds.height !== 'number'
    ) {
      return []
    }
    return [
      {
        windowId,
        pid,
        appName,
        bundleId: typeof bundleId === 'string' ? bundleId : null,
        title: typeof title === 'string' ? title : '',
        bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
      }
    ]
  })
}

/**
 * The listed window `target` names. Why: the renderer sends both ids, but only the native list
 * says which pid owns a window, so a pair the list does not confirm is never authorized.
 */
export function resolveListedTarget(
  windows: readonly DesktopAppWindow[],
  { windowId, pid }: DesktopAppTarget
): DesktopAppTarget {
  const listed = windows.find((w) => w.windowId === windowId)
  if (!listed) {
    throw new Error(`Window ${windowId} is no longer open. Pick the app window again.`)
  }
  if (listed.pid !== pid) {
    throw new Error(`Window ${windowId} does not belong to process ${pid}.`)
  }
  return { windowId: listed.windowId, pid: listed.pid }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
