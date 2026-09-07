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

type UsageRangeArgs<Scope, Range> = {
  scope: Scope
  range: Range
}

function registerProviderHandlers<Scope, Range, BreakdownKind>(
  prefix: UsageProviderChannelPrefix,
  usage: UsageProviderHandlerStore<Scope, Range, BreakdownKind>
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
    (_event, args: UsageRangeArgs<Scope, Range> & { limit?: number }) =>
      usage.getSnapshot(args.scope, args.range, args.limit)
  )
  ipcMain.handle(`${prefix}:getSummary`, (_event, args: UsageRangeArgs<Scope, Range>) =>
    usage.getSummary(args.scope, args.range)
  )
  ipcMain.handle(`${prefix}:getDaily`, (_event, args: UsageRangeArgs<Scope, Range>) =>
    usage.getDaily(args.scope, args.range)
  )
  ipcMain.handle(
    `${prefix}:getBreakdown`,
    (_event, args: UsageRangeArgs<Scope, Range> & { kind: BreakdownKind }) =>
      usage.getBreakdown(args.scope, args.range, args.kind)
  )
  ipcMain.handle(
    `${prefix}:getRecentSessions`,
    (_event, args: UsageRangeArgs<Scope, Range> & { limit?: number }) =>
      usage.getRecentSessions(args.scope, args.range, args.limit)
  )
}

export function registerUsageProviderHandlers(stores: UsageProviderStores): void {
  registerProviderHandlers('claudeUsage', stores.claudeUsage)
  registerProviderHandlers('codexUsage', stores.codexUsage)
  registerProviderHandlers('openCodeUsage', stores.openCodeUsage)
}
