import { ipcMain } from 'electron'
import type { CodexUsageStore } from '../codex-usage/store'
import type {
  CodexUsageBreakdownKind,
  CodexUsageRange,
  CodexUsageScope
} from '../../shared/codex-usage-types'

export function registerCodexUsageHandlers(codexUsage: CodexUsageStore): void {
  ipcMain.handle('codexUsage:getScanState', () => codexUsage.getScanState())
  ipcMain.handle('codexUsage:setEnabled', (_event, args: { enabled: boolean }) =>
    codexUsage.setEnabled(args.enabled)
  )
  ipcMain.handle('codexUsage:refresh', (_event, args?: { force?: boolean }) =>
    codexUsage.refresh(args?.force ?? false)
  )
  ipcMain.handle(
    'codexUsage:getSnapshot',
    (_event, args: { scope: CodexUsageScope; range: CodexUsageRange; limit?: number }) =>
      codexUsage.getSnapshot(args.scope, args.range, args.limit)
  )
  ipcMain.handle(
    'codexUsage:getSummary',
    (_event, args: { scope: CodexUsageScope; range: CodexUsageRange }) =>
      codexUsage.getSummary(args.scope, args.range)
  )
  ipcMain.handle(
    'codexUsage:getDaily',
    (_event, args: { scope: CodexUsageScope; range: CodexUsageRange }) =>
      codexUsage.getDaily(args.scope, args.range)
  )
  ipcMain.handle(
    'codexUsage:getBreakdown',
    (
      _event,
      args: { scope: CodexUsageScope; range: CodexUsageRange; kind: CodexUsageBreakdownKind }
    ) => codexUsage.getBreakdown(args.scope, args.range, args.kind)
  )
  ipcMain.handle(
    'codexUsage:getRecentSessions',
    (_event, args: { scope: CodexUsageScope; range: CodexUsageRange; limit?: number }) =>
      codexUsage.getRecentSessions(args.scope, args.range, args.limit)
  )
}
