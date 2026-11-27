import type { CodexAccountService } from '../../codex-accounts/service'
import type { GlobalSettings } from '../../../shared/settings/global-settings-types'
import { broadcastCodexPendingLoginUrl } from './codex-pending-login-url-broadcast'
import { openAccountSignInLink } from './account-sign-in-link-opener'
import { registerLazyIpcHandleGroup } from '../lazy-ipc-handle-group'

const CODEX_ACCOUNT_IPC_CHANNELS = [
  'codexAccounts:listStalePanes',
  'codexAccounts:listRecordedPaneLanes',
  'codexAccounts:forgetStalePanes',
  'codexAccounts:list',
  'codexAccounts:add',
  'codexAccounts:cancelPendingLogin',
  'codexAccounts:pendingLoginUrl',
  'codexAccounts:reauthenticate',
  'codexAccounts:remove',
  'codexAccounts:rename',
  'codexAccounts:select'
] as const

export function registerLazyCodexAccountHandlers(
  codexAccounts: CodexAccountService,
  getSettings?: () => GlobalSettings
): void {
  // Settings reads the current link on mount; broadcasts carry later changes.
  codexAccounts.onPendingLoginUrlChanged(broadcastCodexPendingLoginUrl)
  codexAccounts.setWslLoginUrlOpener((url) => openAccountSignInLink('codex', url))

  registerLazyIpcHandleGroup(CODEX_ACCOUNT_IPC_CHANNELS, async (ipc) => {
    const { registerCodexAccountHandlers } = await import('./codex-accounts')
    registerCodexAccountHandlers(codexAccounts, getSettings, ipc, {
      registerStartupListeners: false
    })
  })
}
