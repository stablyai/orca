import type {
  CodexEnvironmentHomeOverride,
  CodexShellStartupHomeOverride
} from './codex-real-home-path'
import type {
  CodexPaneAccountRecord,
  CodexPaneHomeRoute
} from './codex-pane-account-registry-types'

// Shape checks for records read back from `codex-pane-accounts.json`; the file is user-writable
// state, so every field is validated rather than trusted.

export function isEnvironmentHomeOverride(value: unknown): value is CodexEnvironmentHomeOverride {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const context = value as Partial<CodexEnvironmentHomeOverride>
  return typeof context.codexHome === 'string' && context.codexHome.length > 0
}

export function isShellStartupHomeOverride(value: unknown): value is CodexShellStartupHomeOverride {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const context = value as Partial<CodexShellStartupHomeOverride>
  return (
    typeof context.home === 'string' &&
    context.home.length > 0 &&
    (context.shell === undefined || typeof context.shell === 'string') &&
    (context.configHome === undefined || typeof context.configHome === 'string') &&
    typeof context.codexHome === 'string' &&
    context.codexHome.length > 0
  )
}

export function isPaneAccountRecord(value: unknown): value is CodexPaneAccountRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const record = value as Partial<CodexPaneAccountRecord>
  return (
    (record.selectionKey === 'host' ||
      (typeof record.selectionKey === 'string' && /^wsl:.+/.test(record.selectionKey))) &&
    (record.accountId === null || typeof record.accountId === 'string')
  )
}

export function isPaneHomeRoute(value: unknown): value is CodexPaneHomeRoute {
  return (
    value === 'real-home' ||
    value === 'shared-home' ||
    value === 'account-home' ||
    value === 'custom-home' ||
    value === 'wsl-home'
  )
}
