import { ipcMain } from 'electron'
import type {
  AiVaultListArgs,
  AiVaultListResult
} from '../../../shared/ai-vault/contracts/ai-vault-types'
import { isAiVaultScanCancelledError } from '../../../shared/ai-vault/contracts/ai-vault-types'
import type { AiVaultScanRows } from '../../../shared/ai-vault-scan-rows'
import { requestedExecutionHostScope } from '../../../shared/execution-host'
import { createSenderScopedRequestCancellations } from '../sender-scoped-request-cancellation'
import { AiVaultRowDelivery, acknowledgeAiVaultRows } from '../ai-vault-row-delivery'
import { cancelledAiVaultListResult } from '../../ai-vault/listing/session-list-results'
import {
  projectStructuredAiVaultSessions,
  OPENS_EVERY_STRUCTURED_CHAT
} from '../../ai-vault/structured-sessions/structured-session-ownership'

export function registerAiVaultListHandler(
  list: (
    args?: AiVaultListArgs,
    options?: { signal?: AbortSignal; observeRows?: (rows: AiVaultScanRows) => void }
  ) => Promise<AiVaultListResult>,
  ensureOwnership: () => unknown
): void {
  const cancellations = createSenderScopedRequestCancellations()
  ipcMain.on('aiVault:rowsAck', acknowledgeAiVaultRows)
  ipcMain.handle('aiVault:listSessions', async (event, args?: AiVaultListArgs) => {
    const requestToken =
      typeof args?.requestToken === 'string' && args.requestToken.length <= 128
        ? args.requestToken
        : undefined
    const controller = cancellations.begin(event, requestToken)
    const host = requestedExecutionHostScope(args?.executionHostScope)
    const delivery =
      requestToken && args?.streamRows
        ? new AiVaultRowDelivery(
            event.sender,
            requestToken,
            controller?.signal,
            host === 'local' || host === 'all'
          )
        : null
    try {
      await ensureOwnership()
      const result = await list(args, {
        signal: controller?.signal,
        observeRows: delivery?.observe
      })
      return projectStructuredAiVaultSessions(result, OPENS_EVERY_STRUCTURED_CHAT)
    } catch (error) {
      if (!isAiVaultScanCancelledError(error)) {
        throw error
      }
      return cancelledAiVaultListResult()
    } finally {
      delivery?.dispose()
      cancellations.finish(event, requestToken, controller)
    }
  })
  ipcMain.handle(
    'aiVault:cancelListSessions',
    (event, args: { requestToken?: string } | undefined) => {
      if (typeof args?.requestToken === 'string' && args.requestToken.length <= 128) {
        cancellations.cancel(event, args.requestToken)
      }
    }
  )
}
