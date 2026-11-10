import { getUiIntlLocale } from '../i18n/ui-intl-locale'
import type { Translate } from '../i18n/mobile-i18n'
import { colors } from '../theme/mobile-theme'
import type { CloudWorkspace, CloudWorkspaceStatus } from './cloud-control-plane-client'

export function cloudStatusLabel(status: CloudWorkspaceStatus, t: Translate): string {
  switch (status) {
    case 'creating':
      return t('cloud.status.creating', 'Starting')
    case 'running':
      return t('cloud.status.running', 'Running')
    case 'waking':
      return t('cloud.status.waking', 'Waking')
    case 'stopping':
      return t('cloud.status.stopping', 'Going to sleep')
    case 'sleeping':
      return t('cloud.status.sleeping', 'Asleep')
    case 'archived':
      return t('cloud.status.archived', 'Archived')
    case 'failed':
      return t('cloud.status.failed', 'Couldn’t start')
  }
}

/** Read at render time: colors are scheme-dependent getters. */
export function cloudStatusColor(status: CloudWorkspaceStatus): string {
  switch (status) {
    // Glossary CloudStateDot: shapes carry the state in a neutral ink; colour is only for problems.
    case 'running':
    case 'creating':
    case 'waking':
    case 'stopping':
      return colors.textSecondary
    case 'failed':
      return colors.statusRed
    case 'sleeping':
    case 'archived':
      return colors.textMuted
  }
}

export function isCloudStatusTransitional(status: CloudWorkspaceStatus): boolean {
  return status === 'creating' || status === 'waking' || status === 'stopping'
}

const hourFormatters = new Map<string, Intl.NumberFormat>()

/** Sandbox hours with one decimal ("3.2"), two under an hour ("0.25"), like the desktop. */
export function cloudSandboxHours(ms: number): { value: number; label: string } {
  const hours = ms / 3_600_000
  const digits = hours < 1 ? 2 : 1
  const value = Math.round(hours * 10 ** digits) / 10 ** digits
  const locale = getUiIntlLocale()
  const key = `${locale}:${digits}`
  let format = hourFormatters.get(key)
  if (!format) {
    try {
      format = new Intl.NumberFormat(locale, { maximumFractionDigits: digits })
    } catch {
      format = new Intl.NumberFormat('en-US', { maximumFractionDigits: digits })
    }
    hourFormatters.set(key, format)
  }
  return { value, label: format.format(value) }
}

/** "owner/repo · branch" from a GitHub URL, or null for an empty project. */
export function cloudRepoLine(workspace: Pick<CloudWorkspace, 'repo'>): string | null {
  if (!workspace.repo) {
    return null
  }
  const path = workspace.repo.url
    .replace(/^https?:\/\/(www\.)?github\.com\//, '')
    .replace(/\.git$/, '')
  return workspace.repo.branch ? `${path} · ${workspace.repo.branch}` : path
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
}

/** "Hello-World", then "Hello-World 2", "Hello-World 3": a new workspace never repeats a title. */
export function nextCloudWorkspaceTitle(
  base: string,
  existing: readonly Pick<CloudWorkspace, 'title'>[]
): string {
  const taken = new Set(existing.map((workspace) => workspace.title))
  if (!taken.has(base)) {
    return base
  }
  let n = 2
  while (taken.has(`${base} ${n}`)) {
    n += 1
  }
  return `${base} ${n}`
}
