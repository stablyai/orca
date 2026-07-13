import { ipcMain } from 'electron'
import type { LocalUsageHistoryHourlyQuery } from '../../shared/local-usage-history-types'
import type { LocalUsageHistoryStore } from '../local-usage-history/store'

export function registerLocalUsageHistoryHandlers(args: {
  geminiUsage: LocalUsageHistoryStore
  kimiUsage: LocalUsageHistoryStore
}): void {
  registerProviderHandlers('geminiUsage', args.geminiUsage)
  registerProviderHandlers('kimiUsage', args.kimiUsage)
}

function registerProviderHandlers(
  channelPrefix: 'geminiUsage' | 'kimiUsage',
  store: LocalUsageHistoryStore
): void {
  ipcMain.handle(`${channelPrefix}:getScanState`, () => store.getScanState())
  ipcMain.handle(`${channelPrefix}:setEnabled`, (_event, args: { enabled: boolean }) =>
    store.setEnabled(args.enabled)
  )
  ipcMain.handle(`${channelPrefix}:refresh`, (_event, args?: { force?: boolean }) =>
    store.refresh(args?.force ?? false)
  )
  ipcMain.handle(`${channelPrefix}:getHourly`, (_event, args: LocalUsageHistoryHourlyQuery) =>
    store.getHourly(args)
  )
}
