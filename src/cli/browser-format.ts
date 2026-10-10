import { formatBase64PayloadByteCount } from './base64-payload-byte-count'
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
  const header = `page: ${result.browserPageId}\n${result.title} — ${result.url}\n`
  return header + result.snapshot
}

export function formatScreenshot(result: BrowserScreenshotResult): string {
  return `Screenshot captured (${result.format}, ${formatBase64PayloadByteCount(result.data)})`
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
