import { BrowserWindow, ipcMain } from 'electron'
import { AI_VAULT_SCAN_PROGRESS_CHANNEL } from '../../shared/ai-vault-scan-progress'
import {
  localAiVaultScanProgress,
  onLocalAiVaultScanProgress
} from '../ai-vault/ai-vault-local-scan-progress'

let unsubscribe: (() => void) | null = null

/** Windows receive keyed changes; a late opener asks for its own scan entry. */
export function registerAiVaultScanProgressBroadcast(): void {
  ipcMain.handle('aiVault:getScanProgress', (_event, scanKey: string) =>
    localAiVaultScanProgress(scanKey)
  )
  unsubscribe?.()
  unsubscribe = onLocalAiVaultScanProgress((update) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(AI_VAULT_SCAN_PROGRESS_CHANNEL, update)
      }
    }
  })
}
