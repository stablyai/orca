import { ipcMain } from 'electron'
import type { ClaudeUsageStore } from '../claude-usage/store'
import type { CodexUsageStore } from '../codex-usage/store'
import type { OpenCodeUsageStore } from '../opencode-usage/store'

type UsageProviderStores = {
  claudeUsage: ClaudeUsageStore
  codexUsage: CodexUsageStore
  openCodeUsage: OpenCodeUsageStore
}

type UsageProviderChannelPrefix = keyof UsageProviderStores

// Why: AccountFilter is inferred from each store so a provider-specific filter
// type stays assignable — `unknown` here would break parameter contravariance.
type UsageProviderHandlerStore<Scope, Range, BreakdownKind, AccountFilter> = {
  getScanState: () => unknown
  setEnabled: (enabled: boolean) => unknown
  refresh: (force?: boolean) => unknown
  getSnapshot: (
    scope: Scope,
    range: Range,
    limit?: number,
    accountFilter?: AccountFilter
  ) => unknown
  getSummary: (scope: Scope, range: Range, accountFilter?: AccountFilter) => unknown
  getDaily: (scope: Scope, range: Range, accountFilter?: AccountFilter) => unknown
  getBreakdown: (
    scope: Scope,
    range: Range,
    kind: BreakdownKind,
    accountFilter?: AccountFilter
  ) => unknown
  getRecentSessions: (
    scope: Scope,
    range: Range,
    limit?: number,
    accountFilter?: AccountFilter
  ) => unknown
}

type UsageRangeArgs<Scope, Range, AccountFilter> = {
  scope: Scope
  range: Range
  accountFilter?: AccountFilter
}

function registerProviderHandlers<Scope, Range, BreakdownKind, AccountFilter>(
  prefix: UsageProviderChannelPrefix,
  usage: UsageProviderHandlerStore<Scope, Range, BreakdownKind, AccountFilter>
): void {
  ipcMain.handle(`${prefix}:getScanState`, () => usage.getScanState())
  ipcMain.handle(`${prefix}:setEnabled`, (_event, args: { enabled: boolean }) =>
    usage.setEnabled(args.enabled)
  )
  ipcMain.handle(`${prefix}:refresh`, (_event, args?: { force?: boolean }) =>
    usage.refresh(args?.force ?? false)
  )
  ipcMain.handle(
    `${prefix}:getSnapshot`,
    (_event, args: UsageRangeArgs<Scope, Range, AccountFilter> & { limit?: number }) =>
      usage.getSnapshot(args.scope, args.range, args.limit, args.accountFilter)
  )
  ipcMain.handle(
    `${prefix}:getSummary`,
    (_event, args: UsageRangeArgs<Scope, Range, AccountFilter>) =>
      usage.getSummary(args.scope, args.range, args.accountFilter)
  )
  ipcMain.handle(
    `${prefix}:getDaily`,
    (_event, args: UsageRangeArgs<Scope, Range, AccountFilter>) =>
      usage.getDaily(args.scope, args.range, args.accountFilter)
  )
  ipcMain.handle(
    `${prefix}:getBreakdown`,
    (_event, args: UsageRangeArgs<Scope, Range, AccountFilter> & { kind: BreakdownKind }) =>
      usage.getBreakdown(args.scope, args.range, args.kind, args.accountFilter)
  )
  ipcMain.handle(
    `${prefix}:getRecentSessions`,
    (_event, args: UsageRangeArgs<Scope, Range, AccountFilter> & { limit?: number }) =>
      usage.getRecentSessions(args.scope, args.range, args.limit, args.accountFilter)
  )
}

export function registerUsageProviderHandlers(stores: UsageProviderStores): void {
  registerProviderHandlers('claudeUsage', stores.claudeUsage)
  registerProviderHandlers('codexUsage', stores.codexUsage)
  registerProviderHandlers('openCodeUsage', stores.openCodeUsage)
}
