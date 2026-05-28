import { ipcMain } from 'electron'
import type { OpenCodeUsageStore } from '../opencode-usage/store'
import type {
  OpenCodeUsageBreakdownKind,
  OpenCodeUsageRange,
  OpenCodeUsageScope
} from '../../shared/opencode-usage-types'

export function registerOpenCodeUsageHandlers(openCodeUsage: OpenCodeUsageStore): void {
  ipcMain.handle('openCodeUsage:getScanState', () => openCodeUsage.getScanState())
  ipcMain.handle('openCodeUsage:setEnabled', (_event, args: { enabled: boolean }) =>
    openCodeUsage.setEnabled(args.enabled)
  )
  ipcMain.handle('openCodeUsage:refresh', (_event, args?: { force?: boolean }) =>
    openCodeUsage.refresh(args?.force ?? false)
  )
  ipcMain.handle(
    'openCodeUsage:getSummary',
    (_event, args: { scope: OpenCodeUsageScope; range: OpenCodeUsageRange }) =>
      openCodeUsage.getSummary(args.scope, args.range)
  )
  ipcMain.handle(
    'openCodeUsage:getDaily',
    (_event, args: { scope: OpenCodeUsageScope; range: OpenCodeUsageRange }) =>
      openCodeUsage.getDaily(args.scope, args.range)
  )
  ipcMain.handle(
    'openCodeUsage:getBreakdown',
    (
      _event,
      args: {
        scope: OpenCodeUsageScope
        range: OpenCodeUsageRange
        kind: OpenCodeUsageBreakdownKind
      }
    ) => openCodeUsage.getBreakdown(args.scope, args.range, args.kind)
  )
  ipcMain.handle(
    'openCodeUsage:getRecentSessions',
    (_event, args: { scope: OpenCodeUsageScope; range: OpenCodeUsageRange; limit?: number }) =>
      openCodeUsage.getRecentSessions(args.scope, args.range, args.limit)
  )
}
