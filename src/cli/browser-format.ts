import { readBrowserActionEffects } from '../shared/browser-action-effects'
import { writeCliScreenshotTempFile } from './cli-screenshot-temp-file'
import type { RuntimeRpcSuccess } from './runtime-client'
import type {
  BrowserProfileListResult,
  BrowserScreenshotResult,
  BrowserSnapshotResult,
  BrowserTabCurrentResult,
  BrowserTabListResult,
  BrowserTabProfileCloneResult,
  BrowserTabProfileShowResult,
  BrowserTabShowResult
} from '../shared/runtime-types'

export function formatSnapshot(result: BrowserSnapshotResult): string {
  // Older runtimes leave url and title unset.
  const location = [result.title, result.url].filter(Boolean).join(' — ')
  const header = [`page: ${result.browserPageId}`, ...(location ? [location] : [])].join('\n')
  return `${header}\n${formatSnapshotBody(result.snapshot)}`
}

function formatSnapshotBody(snapshot: BrowserSnapshotResult['snapshot']): string {
  if (typeof snapshot === 'string') {
    return snapshot
  }
  if (snapshot.kind === 'full') {
    return `revision ${snapshot.revision} (whole tree)\n${snapshot.tree}`
  }
  if (snapshot.kind === 'unchanged') {
    return `revision ${snapshot.revision}: no change since revision ${snapshot.baseRevision}`
  }
  const change = snapshot.treeChange
  const summary = `revision ${snapshot.revision}: changes to revision ${snapshot.baseRevision}`
  if (!change) {
    return `${summary}; the tree lines are the same`
  }
  // 1-based so agents can count lines in the tree they already have.
  const first = change.startLine + 1
  const range =
    change.deleteCount === 1 ? `line ${first}` : `lines ${first}-${first + change.deleteCount - 1}`
  if (change.deleteCount === 0) {
    return [`${summary}; insert before line ${first}:`, ...change.lines].join('\n')
  }
  if (change.lines.length === 0) {
    return `${summary}; delete ${range}`
  }
  return [`${summary}; replace ${range} with:`, ...change.lines].join('\n')
}

export type SavedBrowserScreenshot = Omit<BrowserScreenshotResult, 'data'> & {
  path?: string
  expiresAt?: string
}

const BROWSER_SCREENSHOT_TEMP_DIR = {
  envVar: 'ORCA_BROWSER_SCREENSHOT_TMPDIR',
  dirName: 'orca-browser-screenshots'
}

// Base64 is unreadable to an agent and the host's disk may be another machine, so save it here.
export function saveBrowserScreenshot(
  response: RuntimeRpcSuccess<BrowserScreenshotResult>
): RuntimeRpcSuccess<SavedBrowserScreenshot> {
  const { data, ...result } = response.result
  if (!data) {
    return { ...response, result }
  }
  const saved = writeCliScreenshotTempFile(
    BROWSER_SCREENSHOT_TEMP_DIR,
    response.id,
    data,
    result.format === 'jpeg' ? 'jpg' : 'png'
  )
  return { ...response, result: { ...result, ...saved } }
}

export function formatScreenshot(result: SavedBrowserScreenshot): string {
  if (result.changed === false) {
    return 'Screenshot unchanged since the last --if-changed capture; nothing saved'
  }
  const legend = (result.annotations ?? []).map(
    (a) => `[${a.number}] @${a.ref} ${a.role}${a.name?.trim() ? ` "${a.name.trim()}"` : ''}`
  )
  return [`Screenshot saved to ${result.path} (${result.format})`, ...legend].join('\n')
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
      const popup = t.openerBrowserPageId ? `  (popup opened by ${t.openerBrowserPageId})` : ''
      const unloaded = t.loaded === false ? '  (not loaded)' : ''
      return `${marker}[${t.index}] ${t.browserPageId}  ${t.title} — ${t.url}${profile}${popup}${unloaded}`
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
    `profile: ${tab.profileLabel ?? tab.profileId ?? 'unknown'}`,
    ...(tab.openerBrowserPageId ? [`popup opened by: ${tab.openerBrowserPageId}`] : [])
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

/** What an agent's page action caused, as lines after the action's own; empty when the runtime reported nothing. */
export function formatBrowserActionEffects(result: unknown): string {
  const effects = readBrowserActionEffects(result)
  if (!effects) {
    return ''
  }
  const lines: string[] = []
  if (effects.url !== undefined) {
    lines.push(`Now at ${effects.url} — ${effects.title ?? ''}`)
  } else if (effects.title !== undefined) {
    lines.push(`Title is now ${effects.title}`)
  }
  if (effects.loadError) {
    lines.push(`Load failed: ${effects.loadError}`)
  }
  for (const tab of effects.newTabs ?? []) {
    lines.push(
      tab.browserPageId
        ? `Opened tab ${tab.browserPageId}: ${tab.url}`
        : `Opening a new tab: ${tab.url} (not ready yet; find it with \`tab list\`)`
    )
  }
  for (const popup of effects.popups ?? []) {
    lines.push(
      popup.action === 'blocked'
        ? `Blocked a popup to ${popup.origin}`
        : popup.action === 'opened-external'
          ? `Opened ${popup.origin} in the system browser`
          : `Opened a popup window at ${popup.origin}`
    )
  }
  for (const download of effects.downloads ?? []) {
    lines.push(`Download started: ${download.filename} (from ${download.origin})`)
  }
  for (const error of effects.consoleErrors ?? []) {
    lines.push(`Console error: ${error}`)
  }
  if (effects.loading) {
    lines.push('Still loading; run `wait --load load`, then `snapshot`.')
  } else if (effects.page === undefined) {
    lines.push("Couldn't read the page; run `snapshot`.")
  } else if (effects.page === 'unchanged') {
    lines.push('(no changes)')
  } else if (effects.page) {
    lines.push(effects.page.full ? 'Page:' : 'Page changes:')
    lines.push(...effects.page.lines.map((line) => `  ${line}`))
    if (!effects.page.full && effects.page.removedLines > 0) {
      lines.push(
        `  (${effects.page.removedLines} ${effects.page.removedLines === 1 ? 'line' : 'lines'} removed)`
      )
    }
    if (effects.page.truncated) {
      lines.push('  … run `snapshot` for the rest')
    }
  }
  if (!effects.settled && !effects.loading) {
    lines.push('The page was still changing when this was read.')
  }
  return lines.length > 0 ? `\n${lines.join('\n')}` : ''
}
