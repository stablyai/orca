import { chmodSync, lstatSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { formatBase64PayloadByteCount } from './base64-payload-byte-count'
import { quoteCliCommandArgument } from './shell-command-quote'
import type {
  ComputerActionMetadata,
  ComputerActionResult,
  ComputerListAppsResult,
  ComputerListWindowsResult,
  ComputerSnapshotResult
} from '../shared/runtime-types'
import type { RuntimeRpcSuccess } from './runtime-client'

export function formatGetAppState(result: ComputerSnapshotResult): string {
  const app = result.snapshot.app
  const bundle = app.bundleId ? `, ${app.bundleId}` : ''
  const focused =
    result.snapshot.focusedElementId === null ? 'none' : `#${result.snapshot.focusedElementId}`
  const windowId =
    result.snapshot.window.id === null || result.snapshot.window.id === undefined
      ? ''
      : ` id:${result.snapshot.window.id}`
  const windowIndex =
    result.snapshot.window.index === null || result.snapshot.window.index === undefined
      ? ''
      : ` index:${result.snapshot.window.index}`
  const origin =
    result.snapshot.window.x === null ||
    result.snapshot.window.x === undefined ||
    result.snapshot.window.y === null ||
    result.snapshot.window.y === undefined
      ? ''
      : ` @ ${result.snapshot.window.x},${result.snapshot.window.y}`
  const truncation = result.snapshot.truncation?.truncated
    ? `  Truncated: yes (max nodes ${result.snapshot.truncation.maxNodes ?? 'unknown'}, max depth ${result.snapshot.truncation.maxDepth ?? 'unknown'})`
    : '  Truncated: no'
  return [
    `${app.name} (pid ${app.pid}${bundle})`,
    `  Window:${windowId}${windowIndex} "${result.snapshot.window.title}" (${result.snapshot.window.width}x${result.snapshot.window.height}${origin})`,
    `  Visible elements: ${result.snapshot.elementCount}  Focused: ${focused}  Coordinates: ${result.snapshot.coordinateSpace}`,
    truncation,
    `  ${formatComputerScreenshotStatus(result)}`,
    '',
    result.snapshot.treeText
  ].join('\n')
}

export function prepareComputerCliJsonResult<TResult>(
  response: RuntimeRpcSuccess<TResult>
): RuntimeRpcSuccess<TResult> {
  const record = response as RuntimeRpcSuccess<TResult> & {
    result?: {
      screenshot?: { data?: unknown; format?: unknown; path?: unknown } | null
      screenshotStatus?: unknown
    }
  }
  if (!record.result || !('screenshotStatus' in record.result)) {
    return response
  }
  const screenshot = record.result?.screenshot
  if (!screenshot || typeof screenshot.data !== 'string' || screenshot.data.length === 0) {
    return response
  }
  try {
    const extension = screenshot.format === 'png' ? 'png' : 'img'
    const outputDir = computerScreenshotTempDir()
    cleanupComputerScreenshots(outputDir)
    const outputPath = join(outputDir, `${safeCliFileStem(response.id)}-screenshot.${extension}`)
    writeFileSync(outputPath, Buffer.from(screenshot.data, 'base64'), { mode: 0o600 })
    const expiresAt = new Date(Date.now() + COMPUTER_SCREENSHOT_TTL_MS).toISOString()
    return {
      ...response,
      result: {
        ...record.result,
        screenshot: {
          ...screenshot,
          data: undefined,
          path: outputPath,
          dataOmitted: true,
          expiresAt
        }
      }
    } as RuntimeRpcSuccess<TResult>
  } catch {
    // Why: temp-file export is an ergonomics optimization; keep inline screenshot
    // data when disk, permissions, or path validation would otherwise fail --json.
    return response
  }
}

const COMPUTER_SCREENSHOT_TTL_MS = 24 * 60 * 60 * 1000
const COMPUTER_SCREENSHOT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000
const COMPUTER_SCREENSHOT_CLEANUP_MARKER = '.last-cleanup'

function computerScreenshotTempDir(): string {
  const outputDir =
    process.env.ORCA_COMPUTER_SCREENSHOT_TMPDIR || join(tmpdir(), 'orca-computer-use')
  mkdirSync(outputDir, { recursive: true, mode: 0o700 })
  const stat = lstatSync(outputDir)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Unsafe computer screenshot temp path: ${outputDir}`)
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`Computer screenshot temp path is not owned by the current user: ${outputDir}`)
  }
  chmodSync(outputDir, 0o700)
  return outputDir
}

function cleanupComputerScreenshots(outputDir: string): void {
  const now = Date.now()
  const markerPath = join(outputDir, COMPUTER_SCREENSHOT_CLEANUP_MARKER)
  try {
    // Why: agents can call computer-use CLI commands in loops; a marker keeps
    // temp cleanup from becoming a synchronous directory scan per screenshot.
    if (statSync(markerPath).mtimeMs > now - COMPUTER_SCREENSHOT_CLEANUP_INTERVAL_MS) {
      return
    }
  } catch {
    // Missing or unreadable marker means this process should attempt cleanup.
  }

  const cutoff = now - COMPUTER_SCREENSHOT_TTL_MS
  for (const entry of readdirSync(outputDir)) {
    if (!entry.endsWith('-screenshot.png') && !entry.endsWith('-screenshot.img')) {
      continue
    }
    const path = join(outputDir, entry)
    try {
      if (statSync(path).mtimeMs < cutoff) {
        rmSync(path, { force: true })
      }
    } catch {
      // Best-effort cleanup only; formatting should not fail because a temp file raced.
    }
  }
  try {
    writeFileSync(markerPath, `${now}\n`, { mode: 0o600 })
  } catch {
    // Best-effort marker only; stale cleanup state should not hide a screenshot.
  }
}

function safeCliFileStem(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9._-]/g, '_')
}

export function formatListApps(result: ComputerListAppsResult): string {
  if (result.apps.length === 0) {
    return 'No apps found.'
  }
  return result.apps
    .map((app) => {
      const bundle = app.bundleId ? `  ${app.bundleId}` : ''
      return `${app.name}  pid:${app.pid}${bundle}`
    })
    .join('\n')
}

export function formatListWindows(result: ComputerListWindowsResult): string {
  if (result.windows.length === 0) {
    return `No windows found for ${result.app.name}.`
  }
  return result.windows
    .map((window) => {
      const id = window.id === null || window.id === undefined ? 'none' : String(window.id)
      const origin =
        window.x === null || window.x === undefined || window.y === null || window.y === undefined
          ? ''
          : ` @ ${window.x},${window.y}`
      const screen =
        window.screenIndex === null || window.screenIndex === undefined
          ? ''
          : ` screen:${window.screenIndex}`
      const state = [
        window.isMinimized ? 'minimized' : null,
        window.isOffscreen ? 'offscreen' : null
      ].filter(Boolean)
      const stateText = state.length > 0 ? ` ${state.join(',')}` : ''
      return `[${window.index}] id:${id} "${window.title}" (${window.width}x${window.height}${origin})${screen}${stateText}`
    })
    .join('\n')
}

export type ComputerActionFollowUpTarget = {
  session?: string
  worktree?: string
  windowId?: number
  windowIndex?: number
  restoreWindow?: boolean
}

export function formatComputerAction(
  verb: string,
  result: ComputerActionResult,
  target: ComputerActionFollowUpTarget = {}
): string {
  const path = result.action?.path ? ` via ${result.action.path}` : ''
  const verification = formatActionVerification(result.action)
  const followUpCommand = formatComputerFollowUpCommand(result, target)
  const unverified = isUnverifiedComputerAction(result.action)
  const outcome = unverified ? 'attempted' : 'completed'
  const screenshotFailure = formatComputerActionScreenshotFailure(result)
  const inspectTail = unverified
    ? 'Inspect with the command above or use the --json result before assuming it worked.'
    : 'Use the --json result or rerun state before choosing the next element index.'
  return `${formatActionVerb(verb)} ${outcome}${path}${verification}; ${result.snapshot.elementCount} visible elements in current window.${screenshotFailure} Use \`${followUpCommand}\` to inspect. ${inspectTail}`
}

function formatComputerFollowUpCommand(
  result: ComputerActionResult,
  target: ComputerActionFollowUpTarget
): string {
  const args = [
    'orca',
    'computer',
    'get-app-state',
    '--app',
    quoteCliCommandArgument(result.snapshot.app.bundleId ?? result.snapshot.app.name)
  ]
  if (target.session) {
    args.push('--session', quoteCliCommandArgument(target.session))
  } else if (target.worktree) {
    args.push('--worktree', quoteCliCommandArgument(target.worktree))
  }
  const windowChanged =
    result.action?.verification?.state === 'unverified' &&
    result.action.verification.reason === 'window_changed'
  if (!windowChanged && target.windowId !== undefined) {
    args.push('--window-id', String(target.windowId))
  } else if (!windowChanged && target.windowIndex !== undefined) {
    args.push('--window-index', String(target.windowIndex))
  } else {
    const windowId = result.action?.targetWindowId ?? result.snapshot.window.id
    const windowIndex = result.action?.targetWindowIndex ?? result.snapshot.window.index
    if (windowId !== null && windowId !== undefined) {
      args.push('--window-id', String(windowId))
    } else if (windowIndex !== null && windowIndex !== undefined) {
      args.push('--window-index', String(windowIndex))
    }
  }
  if (target.restoreWindow) {
    args.push('--restore-window')
  }
  return args.join(' ')
}

function formatActionVerification(action: ComputerActionMetadata | undefined): string {
  const verification = action?.verification
  if (!verification) {
    if (action?.path === 'synthetic') {
      return ', unverified (synthetic input)'
    }
    if (action?.path === 'clipboard') {
      return ', unverified (clipboard paste)'
    }
    return ''
  }
  if (verification.state === 'verified') {
    return `, verified ${verification.property}`
  }
  return `, unverified (${verification.reason.replaceAll('_', ' ')})`
}

function isUnverifiedComputerAction(action: ComputerActionMetadata | undefined): boolean {
  if (action?.verification) {
    return action.verification.state === 'unverified'
  }
  return action?.path === 'synthetic' || action?.path === 'clipboard'
}

function formatComputerActionScreenshotFailure(result: ComputerActionResult): string {
  if (result.screenshotStatus.state !== 'failed') {
    return ''
  }
  return ` Screenshot failed (${result.screenshotStatus.code}): ${result.screenshotStatus.message}.`
}

function formatComputerScreenshotStatus(result: ComputerSnapshotResult): string {
  if (result.screenshotStatus.state === 'captured' && result.screenshot) {
    const bytes = result.screenshot.data
      ? formatBase64PayloadByteCount(result.screenshot.data)
      : `saved to ${result.screenshot.path ?? 'temporary file'}`
    const dimensions = `${result.screenshot.width}x${result.screenshot.height}`
    const scale = result.screenshot.scale
    const scaleDetail =
      Number.isFinite(scale) && scale > 0 && scale !== 1
        ? `, scale ${formatComputerScreenshotScale(scale)}; coordinate x/y = screenshot pixels / ${formatComputerScreenshotScale(scale)}`
        : ''
    const engine = result.screenshotStatus.metadata?.engine
    const detail = engine
      ? `${result.screenshot.format}, ${bytes}, ${dimensions}${scaleDetail}, ${engine}`
      : `${result.screenshot.format}, ${bytes}, ${dimensions}${scaleDetail}`
    return `Screenshot captured (${detail})`
  }
  if (result.screenshotStatus.state === 'skipped') {
    return 'Screenshot skipped (--no-screenshot)'
  }
  if (result.screenshotStatus.state === 'failed') {
    return `Screenshot failed (${result.screenshotStatus.code}): ${result.screenshotStatus.message}`
  }
  return 'Screenshot was not captured'
}

function formatComputerScreenshotScale(scale: number): string {
  return Number.isInteger(scale)
    ? String(scale)
    : scale.toFixed(3).replace(/0+$/u, '').replace(/\.$/u, '')
}

function formatActionVerb(verb: string): string {
  return verb
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}
