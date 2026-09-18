import { ipcMain } from 'electron'
import type { ClaudeUsageStore } from '../claude-usage/store'
import type { CodexUsageStore } from '../codex-usage/store'
import type { DevinUsageStore } from '../devin-usage/store'
import type { OpenCodeUsageStore } from '../opencode-usage/store'
import { isTrustedUIRenderer } from './ui'

type UsageProviderStores = {
  claudeUsage: ClaudeUsageStore
  codexUsage: CodexUsageStore
  openCodeUsage: OpenCodeUsageStore
  devinUsage: DevinUsageStore
}

type UsageProviderChannelPrefix = keyof UsageProviderStores

type UsageProviderHandlerStore<Scope, Range, BreakdownKind> = {
  getScanState: () => unknown
  setEnabled: (enabled: boolean) => unknown
  refresh: (force?: boolean) => unknown
  getSnapshot: (scope: Scope, range: Range, limit?: number) => unknown
  getSummary: (scope: Scope, range: Range) => unknown
  getDaily: (scope: Scope, range: Range) => unknown
  getBreakdown: (scope: Scope, range: Range, kind: BreakdownKind) => unknown
  getRecentSessions: (scope: Scope, range: Range, limit?: number) => unknown
}

const VALID_SCOPES = new Set(['orca', 'all'])
const VALID_RANGES = new Set(['7d', '30d', '90d', 'all'])
const VALID_BREAKDOWN_KINDS = new Set(['model', 'project'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object'
}

// Why: these channels mutate state and read usage data, so they require the
// trusted renderer plus runtime-checked payloads — the TS types at the
// preload boundary cannot stop a compromised or stray renderer.
function asScope<Scope>(value: unknown): Scope | null {
  if (typeof value !== 'string' || !VALID_SCOPES.has(value)) {
    return null
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every member of VALID_SCOPES is a valid Scope; membership is checked above.
  return value as Scope
}

function asRange<Range>(value: unknown): Range | null {
  if (typeof value !== 'string' || !VALID_RANGES.has(value)) {
    return null
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every member of VALID_RANGES is a valid Range; membership is checked above.
  return value as Range
}

function asBreakdownKind<BreakdownKind>(value: unknown): BreakdownKind | null {
  if (typeof value !== 'string' || !VALID_BREAKDOWN_KINDS.has(value)) {
    return null
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every member of VALID_BREAKDOWN_KINDS is a valid BreakdownKind; membership is checked above.
  return value as BreakdownKind
}

function asLimit(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined
}

function registerProviderHandlers<Scope, Range, BreakdownKind>(
  prefix: UsageProviderChannelPrefix,
  usage: UsageProviderHandlerStore<Scope, Range, BreakdownKind>
): void {
  ipcMain.handle(`${prefix}:getScanState`, (event) => {
    if (!isTrustedUIRenderer(event.sender)) {
      return null
    }
    return usage.getScanState()
  })
  ipcMain.handle(`${prefix}:setEnabled`, (event, args: unknown) => {
    if (!isTrustedUIRenderer(event.sender) || !isRecord(args)) {
      return null
    }
    return typeof args.enabled === 'boolean' ? usage.setEnabled(args.enabled) : null
  })
  ipcMain.handle(`${prefix}:refresh`, (event, args?: unknown) => {
    if (!isTrustedUIRenderer(event.sender)) {
      return null
    }
    const force = isRecord(args) && typeof args.force === 'boolean' ? args.force : false
    return usage.refresh(force)
  })
  ipcMain.handle(`${prefix}:getSnapshot`, (event, args: unknown) => {
    if (!isTrustedUIRenderer(event.sender) || !isRecord(args)) {
      return null
    }
    const scope = asScope<Scope>(args.scope)
    const range = asRange<Range>(args.range)
    if (scope === null || range === null) {
      return null
    }
    return usage.getSnapshot(scope, range, asLimit(args.limit))
  })
  ipcMain.handle(`${prefix}:getSummary`, (event, args: unknown) => {
    if (!isTrustedUIRenderer(event.sender) || !isRecord(args)) {
      return null
    }
    const scope = asScope<Scope>(args.scope)
    const range = asRange<Range>(args.range)
    return scope === null || range === null ? null : usage.getSummary(scope, range)
  })
  ipcMain.handle(`${prefix}:getDaily`, (event, args: unknown) => {
    if (!isTrustedUIRenderer(event.sender) || !isRecord(args)) {
      return null
    }
    const scope = asScope<Scope>(args.scope)
    const range = asRange<Range>(args.range)
    return scope === null || range === null ? null : usage.getDaily(scope, range)
  })
  ipcMain.handle(`${prefix}:getBreakdown`, (event, args: unknown) => {
    if (!isTrustedUIRenderer(event.sender) || !isRecord(args)) {
      return null
    }
    const scope = asScope<Scope>(args.scope)
    const range = asRange<Range>(args.range)
    const kind = asBreakdownKind<BreakdownKind>(args.kind)
    return scope === null || range === null || kind === null
      ? null
      : usage.getBreakdown(scope, range, kind)
  })
  ipcMain.handle(`${prefix}:getRecentSessions`, (event, args: unknown) => {
    if (!isTrustedUIRenderer(event.sender) || !isRecord(args)) {
      return null
    }
    const scope = asScope<Scope>(args.scope)
    const range = asRange<Range>(args.range)
    return scope === null || range === null
      ? null
      : usage.getRecentSessions(scope, range, asLimit(args.limit))
  })
}

export function registerUsageProviderHandlers(stores: UsageProviderStores): void {
  registerProviderHandlers('claudeUsage', stores.claudeUsage)
  registerProviderHandlers('codexUsage', stores.codexUsage)
  registerProviderHandlers('openCodeUsage', stores.openCodeUsage)
  registerProviderHandlers('devinUsage', stores.devinUsage)
}
