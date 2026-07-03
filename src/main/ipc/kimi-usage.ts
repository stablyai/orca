import { ipcMain } from 'electron'
import type { KimiUsageStore } from '../kimi-usage/store'
import type {
  KimiUsageBreakdownKind,
  KimiUsageRange,
  KimiUsageScope
} from '../../shared/kimi-usage-types'

export function registerKimiUsageHandlers(kimiUsage: KimiUsageStore): void {
  ipcMain.handle('kimiUsage:getScanState', () => kimiUsage.getScanState())
  ipcMain.handle('kimiUsage:setEnabled', (_event, args: { enabled: boolean }) =>
    kimiUsage.setEnabled(args.enabled)
  )
  ipcMain.handle('kimiUsage:refresh', (_event, args?: { force?: boolean }) =>
    kimiUsage.refresh(args?.force ?? false)
  )
  ipcMain.handle(
    'kimiUsage:getSnapshot',
    (_event, args: { scope: KimiUsageScope; range: KimiUsageRange; limit?: number }) =>
      kimiUsage.getSnapshot(args.scope, args.range, args.limit)
  )
  ipcMain.handle(
    'kimiUsage:getSummary',
    (_event, args: { scope: KimiUsageScope; range: KimiUsageRange }) =>
      kimiUsage.getSummary(args.scope, args.range)
  )
  ipcMain.handle(
    'kimiUsage:getDaily',
    (_event, args: { scope: KimiUsageScope; range: KimiUsageRange }) =>
      kimiUsage.getDaily(args.scope, args.range)
  )
  ipcMain.handle(
    'kimiUsage:getBreakdown',
    (
      _event,
      args: {
        scope: KimiUsageScope
        range: KimiUsageRange
        kind: KimiUsageBreakdownKind
      }
    ) => kimiUsage.getBreakdown(args.scope, args.range, args.kind)
  )
  ipcMain.handle(
    'kimiUsage:getRecentSessions',
    (_event, args: { scope: KimiUsageScope; range: KimiUsageRange; limit?: number }) =>
      kimiUsage.getRecentSessions(args.scope, args.range, args.limit)
  )
}
