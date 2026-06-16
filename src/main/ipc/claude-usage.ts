import { ipcMain } from 'electron'
import type { ClaudeUsageStore } from '../claude-usage/store'
import type {
  ClaudeUsageBreakdownKind,
  ClaudeUsageRange,
  ClaudeUsageScope
} from '../../shared/claude-usage-types'

export function registerClaudeUsageHandlers(claudeUsage: ClaudeUsageStore): void {
  ipcMain.handle('claudeUsage:getScanState', () => claudeUsage.getScanState())
  ipcMain.handle('claudeUsage:setEnabled', (_event, args: { enabled: boolean }) =>
    claudeUsage.setEnabled(args.enabled)
  )
  ipcMain.handle('claudeUsage:refresh', (_event, args?: { force?: boolean }) =>
    claudeUsage.refresh(args?.force ?? false)
  )
  ipcMain.handle(
    'claudeUsage:getSnapshot',
    (_event, args: { scope: ClaudeUsageScope; range: ClaudeUsageRange; limit?: number }) =>
      claudeUsage.getSnapshot(args.scope, args.range, args.limit)
  )
  ipcMain.handle(
    'claudeUsage:getSummary',
    (_event, args: { scope: ClaudeUsageScope; range: ClaudeUsageRange }) =>
      claudeUsage.getSummary(args.scope, args.range)
  )
  ipcMain.handle(
    'claudeUsage:getDaily',
    (_event, args: { scope: ClaudeUsageScope; range: ClaudeUsageRange }) =>
      claudeUsage.getDaily(args.scope, args.range)
  )
  ipcMain.handle(
    'claudeUsage:getBreakdown',
    (
      _event,
      args: { scope: ClaudeUsageScope; range: ClaudeUsageRange; kind: ClaudeUsageBreakdownKind }
    ) => claudeUsage.getBreakdown(args.scope, args.range, args.kind)
  )
  ipcMain.handle(
    'claudeUsage:getRecentSessions',
    (_event, args: { scope: ClaudeUsageScope; range: ClaudeUsageRange; limit?: number }) =>
      claudeUsage.getRecentSessions(args.scope, args.range, args.limit)
  )
}
