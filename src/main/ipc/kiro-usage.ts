import { ipcMain } from 'electron'
import type { RateLimitService } from '../rate-limits/service'
import { getKiroUsageRefresh } from '../kiro-usage/kiro-usage-refresh-registry'

// Kiro usage is a ~10s kiro-cli `/usage` read. The renderer asks for it here and
// awaits only the settle — the value itself lands in the rate-limit state and
// reaches the UI over the same `rateLimits:update` push as every polled
// provider, which is also what keeps desktop and a paired phone in agreement.
// The phone's own lane never awaits: see RuntimeAccountController.
export function registerKiroUsageHandlers(rateLimits: RateLimitService): void {
  ipcMain.handle('kiroUsage:refresh', async (_event, force?: boolean): Promise<void> => {
    await getKiroUsageRefresh(rateLimits).requestRefresh({ force: force === true })
  })
}
