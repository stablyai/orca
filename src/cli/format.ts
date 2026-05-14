/* eslint-disable max-lines -- Why: CLI result formatters are centralized so handlers can stay thin RPC glue. */
import { chmodSync, lstatSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type {
  BrowserProfileListResult,
  BrowserTabCurrentResult,
  BrowserScreenshotResult,
  BrowserSnapshotResult,
  BrowserTabListResult,
  BrowserTabProfileCloneResult,
  BrowserTabProfileShowResult,
  BrowserTabShowResult,
  ComputerActionResult,
  ComputerActionVerification,
  ComputerListAppsResult,
  ComputerListWindowsResult,
  ComputerSnapshotResult,
  CliStatusResult,
  RuntimeRepoList,
  RuntimeRepoSearchRefs,
  RuntimeTerminalClose,
  RuntimeTerminalCreate,
  RuntimeTerminalFocus,
  RuntimeTerminalListResult,
  RuntimeTerminalRead,
  RuntimeTerminalRename,
  RuntimeTerminalSend,
  RuntimeTerminalShow,
  RuntimeTerminalSplit,
  RuntimeTerminalWait,
  RuntimeWorktreeListResult,
  RuntimeWorktreePsResult,
  RuntimeWorktreeRecord
} from '../shared/runtime-types'
import type { NoteListResult, NoteMutationResult, NoteShowResult } from '../shared/notes-types'
import type { RuntimeRpcFailure, RuntimeRpcSuccess } from './runtime-client'
import { RuntimeClientError, RuntimeRpcFailureError } from './runtime-client'

export function printResult<TResult>(
  response: RuntimeRpcSuccess<TResult>,
  json: boolean,
  formatter: (value: TResult) => string
): void {
  if (json) {
    console.log(JSON.stringify(prepareCliJsonResult(response), null, 2))
    return
  }
  console.log(formatter(response.result))
}

export function formatCliError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (error instanceof RuntimeClientError && error.code === 'runtime_unavailable') {
    return `${message}\nOrca is not running. Run 'orca open' first.`
  }
  if (
    error instanceof RuntimeRpcFailureError &&
    error.response.error.code === 'runtime_unavailable'
  ) {
    return `${message}\nOrca is not running. Run 'orca open' first.`
  }
  return message
}

export function reportCliError(error: unknown, json: boolean): void {
  if (json) {
    if (error instanceof RuntimeRpcFailureError) {
      console.log(JSON.stringify(error.response, null, 2))
    } else {
      const response: RuntimeRpcFailure = {
        id: 'local',
        ok: false,
        error: {
          code: error instanceof RuntimeClientError ? error.code : 'runtime_error',
          message: formatCliError(error)
        },
        _meta: {
          runtimeId: null
        }
      }
      console.log(JSON.stringify(response, null, 2))
    }
  } else {
    console.error(formatCliError(error))
  }
}

export function formatCliStatus(status: CliStatusResult): string {
  return [
    `appRunning: ${status.app.running}`,
    `pid: ${status.app.pid ?? 'none'}`,
    `runtimeState: ${status.runtime.state}`,
    `runtimeReachable: ${status.runtime.reachable}`,
    `runtimeId: ${status.runtime.runtimeId ?? 'none'}`,
    `graphState: ${status.graph.state}`
  ].join('\n')
}

export function formatStatus(status: CliStatusResult): string {
  return formatCliStatus(status)
}

export function formatTerminalList(result: RuntimeTerminalListResult): string {
  if (result.terminals.length === 0) {
    return 'No live terminals.'
  }
  const body = result.terminals
    .map(
      (terminal) =>
        `${terminal.handle}  ${terminal.title ?? '(untitled)'}  ${terminal.connected ? 'connected' : 'disconnected'}  ${terminal.worktreePath}\n${terminal.preview ? `preview: ${terminal.preview}` : 'preview: <empty>'}`
    )
    .join('\n\n')
  return result.truncated
    ? `${body}\n\ntruncated: showing ${result.terminals.length} of ${result.totalCount}`
    : body
}

export function formatTerminalShow(result: { terminal: RuntimeTerminalShow }): string {
  const terminal = result.terminal
  return [
    `handle: ${terminal.handle}`,
    `title: ${terminal.title ?? '(untitled)'}`,
    `worktree: ${terminal.worktreePath}`,
    `branch: ${terminal.branch}`,
    `leaf: ${terminal.leafId}`,
    `ptyId: ${terminal.ptyId ?? 'none'}`,
    `connected: ${terminal.connected}`,
    `writable: ${terminal.writable}`,
    `preview: ${terminal.preview || '<empty>'}`
  ].join('\n')
}

export function formatTerminalRead(result: { terminal: RuntimeTerminalRead }): string {
  const terminal = result.terminal
  const header = [
    `handle: ${terminal.handle}`,
    `status: ${terminal.status}`,
    ...(terminal.nextCursor !== null ? [`cursor: ${terminal.nextCursor}`] : [])
  ]
  return [...header, '', ...terminal.tail].join('\n')
}

export function formatTerminalSend(result: { send: RuntimeTerminalSend }): string {
  return `Sent ${result.send.bytesWritten} bytes to ${result.send.handle}.`
}

export function formatTerminalRename(result: { rename: RuntimeTerminalRename }): string {
  return result.rename.title
    ? `Renamed terminal ${result.rename.handle} to "${result.rename.title}".`
    : `Cleared title for terminal ${result.rename.handle}.`
}

export function formatTerminalCreate(result: { terminal: RuntimeTerminalCreate }): string {
  const titleNote = result.terminal.title ? ` (title: "${result.terminal.title}")` : ''
  const surfaceNote = result.terminal.surface ? ` [${result.terminal.surface}]` : ''
  return `Created terminal ${result.terminal.handle}${titleNote}${surfaceNote}`
}

export function formatTerminalSplit(result: { split: RuntimeTerminalSplit }): string {
  return `Split pane ${result.split.handle} in tab ${result.split.tabId}`
}

export function formatTerminalFocus(result: { focus: RuntimeTerminalFocus }): string {
  return `Focused terminal ${result.focus.handle} (tab ${result.focus.tabId}).`
}

export function formatTerminalClose(result: { close: RuntimeTerminalClose }): string {
  const ptyNote = result.close.ptyKilled ? ' PTY killed.' : ''
  return `Closed terminal ${result.close.handle}.${ptyNote}`
}

export function formatTerminalWait(result: { wait: RuntimeTerminalWait }): string {
  return [
    `handle: ${result.wait.handle}`,
    `condition: ${result.wait.condition}`,
    `satisfied: ${result.wait.satisfied}`,
    `status: ${result.wait.status}`,
    `exitCode: ${result.wait.exitCode ?? 'null'}`
  ].join('\n')
}

export function formatNoteList(result: NoteListResult): string {
  if (result.notes.length === 0) {
    return 'No notes.'
  }
  const body = result.notes
    .map((note) => {
      const link = note.linkKind ? `  ${note.linkKind}` : ''
      const preview = note.preview ? `\n${note.preview}` : ''
      return `${note.id}  ${note.title}${link}\npath: ${note.relativePath}\nupdated: ${note.updatedAt}${preview}`
    })
    .join('\n\n')
  return result.truncated
    ? `${body}\n\ntruncated: showing ${result.notes.length} of ${result.totalCount}`
    : body
}

export function formatNoteShow(result: NoteShowResult): string {
  const link = result.linkKind ? `link: ${result.linkKind}` : 'link: none'
  return [
    `id: ${result.note.id}`,
    `path: ${result.note.relativePath}`,
    `title: ${result.note.title}`,
    `revision: ${result.note.revision}`,
    link,
    '',
    result.note.bodyMarkdown
  ].join('\n')
}

export function formatNoteMutation(result: NoteMutationResult): string {
  return `Saved note ${result.note.id} (${result.note.title}) revision ${result.note.revision}.`
}

export function formatWorktreePs(result: RuntimeWorktreePsResult): string {
  if (result.worktrees.length === 0) {
    return 'No worktrees found.'
  }
  const body = result.worktrees
    .map(
      (worktree) =>
        `${worktree.repo} ${worktree.branch}  live:${worktree.liveTerminalCount}  pty:${worktree.hasAttachedPty ? 'yes' : 'no'}  unread:${worktree.unread ? 'yes' : 'no'}\n${worktree.path}${worktree.preview ? `\npreview: ${worktree.preview}` : ''}`
    )
    .join('\n\n')
  return result.truncated
    ? `${body}\n\ntruncated: showing ${result.worktrees.length} of ${result.totalCount}`
    : body
}

export function formatRepoList(result: RuntimeRepoList): string {
  if (result.repos.length === 0) {
    return 'No repos found.'
  }
  return result.repos.map((repo) => `${repo.id}  ${repo.displayName}  ${repo.path}`).join('\n')
}

export function formatRepoShow(result: { repo: Record<string, unknown> }): string {
  return Object.entries(result.repo)
    .map(
      ([key, value]) =>
        `${key}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`
    )
    .join('\n')
}

export function formatRepoRefs(result: RuntimeRepoSearchRefs): string {
  if (result.refs.length === 0) {
    return 'No refs found.'
  }
  return result.truncated ? `${result.refs.join('\n')}\n\ntruncated: yes` : result.refs.join('\n')
}

export function formatWorktreeList(result: RuntimeWorktreeListResult): string {
  if (result.worktrees.length === 0) {
    return 'No worktrees found.'
  }
  const body = result.worktrees
    .map(
      (worktree) =>
        `${String(worktree.id)}  ${String(worktree.branch)}  ${String(worktree.path)}\ndisplayName: ${String(worktree.displayName ?? '')}\nlinkedIssue: ${String(worktree.linkedIssue ?? 'null')}\ncomment: ${String(worktree.comment ?? '')}`
    )
    .join('\n\n')
  return result.truncated
    ? `${body}\n\ntruncated: showing ${result.worktrees.length} of ${result.totalCount}`
    : body
}

export function formatWorktreeShow(result: { worktree: RuntimeWorktreeRecord }): string {
  const worktree = result.worktree
  return Object.entries(worktree)
    .map(
      ([key, value]) =>
        `${key}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`
    )
    .join('\n')
}

export function formatSnapshot(result: BrowserSnapshotResult): string {
  const header = `page: ${result.browserPageId}\n${result.title} — ${result.url}\n`
  return header + result.snapshot
}

export function formatScreenshot(result: BrowserScreenshotResult): string {
  return `Screenshot captured (${result.format}, ${Math.round(result.data.length * 0.75)} bytes)`
}

export function formatTabList(result: BrowserTabListResult): string {
  return formatTabListWithProfiles(result, false)
}

export function formatTabListWithProfiles(
  result: BrowserTabListResult,
  showProfile: boolean
): string {
  if (result.tabs.length === 0) {
    return 'No browser tabs open.'
  }
  return result.tabs
    .map((t) => {
      const marker = t.active ? '* ' : '  '
      const profile = showProfile ? `  [${t.profileLabel ?? t.profileId ?? 'Unknown'}]` : ''
      return `${marker}[${t.index}] ${t.browserPageId}  ${t.title} — ${t.url}${profile}`
    })
    .join('\n')
}

export function formatBrowserProfileList(result: BrowserProfileListResult): string {
  if (result.profiles.length === 0) {
    return 'No browser profiles found.'
  }
  return result.profiles
    .map((profile) => {
      const marker = profile.scope === 'default' ? '* ' : '  '
      const source = profile.source?.browserFamily ?? 'none'
      return `${marker}${profile.id}  ${profile.label}  ${profile.scope}  source:${source}`
    })
    .join('\n')
}

export function formatTabShow(result: BrowserTabShowResult | BrowserTabCurrentResult): string {
  const tab = result.tab
  return [
    `page: ${tab.browserPageId}`,
    `title: ${tab.title}`,
    `url: ${tab.url}`,
    `active: ${tab.active}`,
    `worktree: ${tab.worktreeId ?? 'unknown'}`,
    `profile: ${tab.profileLabel ?? tab.profileId ?? 'unknown'}`
  ].join('\n')
}

export function formatTabProfileShow(result: BrowserTabProfileShowResult): string {
  return [
    `page: ${result.browserPageId}`,
    `worktree: ${result.worktreeId ?? 'unknown'}`,
    `profileId: ${result.profileId ?? 'default'}`,
    `profile: ${result.profileLabel ?? result.profileId ?? 'default'}`
  ].join('\n')
}

export function formatTabProfileClone(result: BrowserTabProfileCloneResult): string {
  return `Cloned ${result.sourceBrowserPageId} to ${result.browserPageId} (${result.profileLabel ?? result.profileId ?? 'default'})`
}

export function formatGetAppState(result: ComputerSnapshotResult): string {
  const app = result.snapshot.app
  const bundle = app.bundleId ? `, ${app.bundleId}` : ''
  const focused =
    result.snapshot.focusedElementId === null ? 'none' : `#${result.snapshot.focusedElementId}`
  const windowId =
    result.snapshot.window.id === null || result.snapshot.window.id === undefined
      ? ''
      : ` id:${result.snapshot.window.id}`
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
    `  Window:${windowId} "${result.snapshot.window.title}" (${result.snapshot.window.width}x${result.snapshot.window.height}${origin})`,
    `  Elements: ${result.snapshot.elementCount}  Focused: ${focused}  Coordinates: ${result.snapshot.coordinateSpace}`,
    truncation,
    `  ${formatComputerScreenshotStatus(result)}`,
    '',
    result.snapshot.treeText
  ].join('\n')
}

function prepareCliJsonResult<TResult>(
  response: RuntimeRpcSuccess<TResult>
): RuntimeRpcSuccess<TResult> {
  const record = response as RuntimeRpcSuccess<TResult> & {
    result?: { screenshot?: { data?: unknown; format?: unknown; path?: unknown } | null }
  }
  const screenshot = record.result?.screenshot
  if (!screenshot || typeof screenshot.data !== 'string' || screenshot.data.length === 0) {
    return response
  }
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
}

const COMPUTER_SCREENSHOT_TTL_MS = 24 * 60 * 60 * 1000

function computerScreenshotTempDir(): string {
  const outputDir = join(tmpdir(), 'orca-computer-use')
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
  const cutoff = Date.now() - COMPUTER_SCREENSHOT_TTL_MS
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

export function formatComputerAction(verb: string, result: ComputerActionResult): string {
  const path = result.action?.path ? ` via ${result.action.path}` : ''
  const verification = formatActionVerification(result.action?.verification)
  const app = shellQuote(result.snapshot.app.bundleId ?? result.snapshot.app.name)
  const windowId =
    result.snapshot.window.id === null || result.snapshot.window.id === undefined
      ? ''
      : ` --window-id ${result.snapshot.window.id}`
  return `${formatActionVerb(verb)} completed${path}${verification}; ${result.snapshot.elementCount} elements in current window. Use \`orca computer get-app-state --app ${app}${windowId}\` to inspect.`
}

function formatActionVerification(verification: ComputerActionVerification | undefined): string {
  if (!verification) {
    return ''
  }
  if (verification.state === 'verified') {
    return `, verified ${verification.property}`
  }
  return `, unverified (${verification.reason.replaceAll('_', ' ')})`
}

function formatComputerScreenshotStatus(result: ComputerSnapshotResult): string {
  if (result.screenshotStatus.state === 'captured' && result.screenshot) {
    const bytes = result.screenshot.data
      ? `${Math.round(result.screenshot.data.length * 0.75)} bytes`
      : `saved to ${result.screenshot.path ?? 'temporary file'}`
    const engine = result.screenshotStatus.metadata?.engine
    const detail = engine
      ? `${result.screenshot.format}, ${bytes}, ${engine}`
      : `${result.screenshot.format}, ${bytes}`
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

function shellQuote(value: string): string {
  if (/^[a-zA-Z0-9._:/@-]+$/.test(value)) {
    return value
  }
  return `'${value.replaceAll("'", "'\\''")}'`
}

function formatActionVerb(verb: string): string {
  return verb
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}
