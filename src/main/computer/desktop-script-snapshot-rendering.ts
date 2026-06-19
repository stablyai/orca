import type { ComputerSnapshotResult } from '../../shared/runtime-types'
import { RuntimeClientError } from './runtime-client-error'
import type { BridgeResponse, BridgeSnapshot, BridgeWindow } from './desktop-script-provider-types'

export function renderSnapshot(
  snapshot: BridgeSnapshot,
  noScreenshot: boolean
): ComputerSnapshotResult {
  const bounds = snapshot.windowBounds
  const treeText = renderTreeText(snapshot)
  const focusedElementId = normalizedFocusedElementId(snapshot)
  // Why: Linux/Windows providers may downscale screenshots to cap IPC payloads,
  // while window bounds remain the unscaled coordinate space for actions.
  const screenshotWidth =
    positiveRoundedNumber(snapshot.screenshotWidth) ?? Math.max(1, Math.round(bounds?.width ?? 1))
  const screenshotHeight =
    positiveRoundedNumber(snapshot.screenshotHeight) ?? Math.max(1, Math.round(bounds?.height ?? 1))
  const screenshotScale = positiveNumber(snapshot.screenshotScale) ?? 1
  const screenshot = snapshot.screenshotPngBase64
    ? {
        data: snapshot.screenshotPngBase64,
        format: 'png' as const,
        width: screenshotWidth,
        height: screenshotHeight,
        scale: screenshotScale
      }
    : null
  return {
    snapshot: {
      // Why: bridge elements can be large; keep them cached internally for actions
      // instead of returning duplicated metadata in every agent-facing snapshot.
      id: snapshot.snapshotId ?? fallbackSnapshotId(snapshot),
      app: {
        name: snapshot.app.name,
        bundleId: snapshot.app.bundleId ?? snapshot.app.bundleIdentifier ?? null,
        pid: snapshot.app.pid
      },
      window: {
        title: snapshot.windowTitle ?? snapshot.app.name,
        id: snapshot.windowId ?? null,
        index: snapshot.windowIndex ?? null,
        x: bounds ? Math.round(bounds.x) : null,
        y: bounds ? Math.round(bounds.y) : null,
        width: Math.max(0, Math.round(bounds?.width ?? 0)),
        height: Math.max(0, Math.round(bounds?.height ?? 0)),
        isMinimized: null,
        isOffscreen: null,
        screenIndex: null
      },
      coordinateSpace: snapshot.coordinateSpace ?? 'window',
      treeText,
      elementCount: snapshot.elements?.length ?? 0,
      focusedElementId,
      truncation: {
        truncated: snapshot.truncation?.truncated === true,
        maxNodes: snapshot.truncation?.maxNodes,
        maxDepth: snapshot.truncation?.maxDepth,
        maxDepthReached: snapshot.truncation?.maxDepthReached === true
      }
    },
    screenshot,
    screenshotStatus: screenshot
      ? {
          state: 'captured',
          metadata: { engine: 'unknown', windowId: snapshot.windowId ?? null }
        }
      : noScreenshot
        ? { state: 'skipped', reason: 'no_screenshot_flag' }
        : desktopScreenshotFailureStatus(snapshot)
  }
}

function desktopScreenshotFailureStatus(
  snapshot: BridgeSnapshot
): ComputerSnapshotResult['screenshotStatus'] {
  if (snapshot.screenshotError?.message) {
    return {
      state: 'failed',
      code: 'screenshot_failed',
      message: snapshot.screenshotError.message
    }
  }
  return {
    state: 'failed',
    code: 'screenshot_failed',
    message:
      'desktop provider returned no image; grant screen capture permission or pass --no-screenshot to inspect accessibility state only.'
  }
}

export function snapshotWithoutScreenshot(snapshot: BridgeSnapshot): BridgeSnapshot {
  return snapshot.screenshotPngBase64 ? { ...snapshot, screenshotPngBase64: null } : snapshot
}

function normalizedFocusedElementId(snapshot: BridgeSnapshot): number | null {
  const focusedElementId = snapshot.focusedElementId
  if (focusedElementId === null || focusedElementId === undefined) {
    return null
  }
  return snapshot.elements?.some((element) => element.index === focusedElementId) === true
    ? focusedElementId
    : null
}

function positiveNumber(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

function positiveRoundedNumber(value: number | null | undefined): number | null {
  const numberValue = positiveNumber(value)
  return numberValue === null ? null : Math.max(1, Math.round(numberValue))
}

function fallbackSnapshotId(snapshot: BridgeSnapshot): string {
  const appRef = snapshot.app.bundleId ?? snapshot.app.bundleIdentifier ?? snapshot.app.name
  const windowRef =
    snapshot.windowId !== null && snapshot.windowId !== undefined
      ? String(snapshot.windowId)
      : snapshot.windowIndex !== null && snapshot.windowIndex !== undefined
        ? `window-index:${snapshot.windowIndex}`
        : 'window'
  return `${appRef}:${snapshot.app.pid}:${windowRef}`
}

function renderTreeText(snapshot: BridgeSnapshot): string {
  const appRef = snapshot.app.bundleId ?? snapshot.app.bundleIdentifier ?? snapshot.app.name
  const lines = [
    `App=${appRef} (pid ${snapshot.app.pid})`,
    `Window: "${sanitize(snapshot.windowTitle ?? snapshot.app.name)}", App: ${sanitize(snapshot.app.name)}.`,
    '',
    ...(snapshot.treeLines ?? [])
  ]
  if (snapshot.selectedText) {
    lines.push('', `Selected text: [${sanitize(snapshot.selectedText)}]`)
  } else if (snapshot.focusedSummary) {
    lines.push('', `The focused UI element is ${sanitize(snapshot.focusedSummary)}.`)
  }
  return lines.join('\n')
}

export function normalizeBridgeApp(app: BridgeResponse['app'] | BridgeWindow['app'] | undefined) {
  if (!app) {
    throw new RuntimeClientError('accessibility_error', 'desktop provider returned no app')
  }
  return {
    name: app.name,
    bundleId: app.bundleId ?? app.bundleIdentifier ?? null,
    pid: app.pid
  }
}

function sanitize(value: string): string {
  return value.replaceAll('\n', ' ').replaceAll('\r', ' ')
}
