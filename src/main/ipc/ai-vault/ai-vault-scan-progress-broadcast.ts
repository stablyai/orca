import { publishToDocuments, registerAppHandler } from '../app-registry/app-handler-registry'
import { BrowserWindow } from 'electron'
import { AI_VAULT_SCAN_PROGRESS_CHANNEL } from '../../../shared/ai-vault/scanning/ai-vault-scan-progress'
import {
  localAiVaultScanProgress,
  onLocalAiVaultScanProgress
} from '../../ai-vault/scan-lifecycle/ai-vault-local-scan-progress'

let unsubscribe: (() => void) | null = null

/** Windows receive keyed changes; a late opener asks for its own scan entry. */
export function registerAiVaultScanProgressBroadcast(): void {
  registerAppHandler('aiVault:getScanProgress', (_event, scanKey: string) =>
    localAiVaultScanProgress(scanKey)
  )
  unsubscribe?.()
  unsubscribe = onLocalAiVaultScanProgress((update) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        publishToDocuments(AI_VAULT_SCAN_PROGRESS_CHANNEL, update, {
          sourceId: window.webContents.id
        })
      }
    }
  })
}
