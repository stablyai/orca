import { registerAppHandler } from '../app-registry/app-handler-registry'

import type { CodexAccountService } from '../../codex-accounts/service'
import type { CodexAccountAddTarget } from '../../codex-accounts/account-management/codex-account-service-types'
import type { CodexAccountSelectionTarget } from '../../../shared/agent-accounts/codex/codex-selection-lane'
import { broadcastCodexPendingLoginUrl } from './codex-pending-login-url-broadcast'
import { openAccountSignInLink } from './account-sign-in-link-opener'
import { listRecordedCodexPaneLanes } from '../../codex/configuration/homes/codex-pane-account-registry'
import {
  forgetStaleCodexPanes,
  listStaleCodexPanes
} from '../../codex/configuration/homes/codex-stale-pane-accounts'
import type { GlobalSettings } from '../../../shared/settings/global-settings-types'

export function registerCodexAccountHandlers(
  codexAccounts: CodexAccountService,
  getSettings?: () => GlobalSettings
): void {
  registerAppHandler('codexAccounts:listStalePanes', (_event, args: { ptyIds?: unknown }) => {
    const settings = getSettings?.()
    if (!settings || !Array.isArray(args?.ptyIds)) {
      return []
    }
    return listStaleCodexPanes({
      ptyIds: args.ptyIds.filter((ptyId): ptyId is string => typeof ptyId === 'string'),
      settings
    })
  })
  registerAppHandler(
    'codexAccounts:listRecordedPaneLanes',
    (_event, args: { ptyIds?: unknown }) => {
      if (!Array.isArray(args?.ptyIds)) {
        return {}
      }
      return listRecordedCodexPaneLanes(
        args.ptyIds.filter((ptyId): ptyId is string => typeof ptyId === 'string')
      )
    }
  )
  registerAppHandler('codexAccounts:forgetStalePanes', (_event, args: { ptyIds?: unknown }) => {
    if (!Array.isArray(args?.ptyIds)) {
      return
    }
    forgetStaleCodexPanes(args.ptyIds.filter((ptyId): ptyId is string => typeof ptyId === 'string'))
  })
  registerAppHandler('codexAccounts:list', () => codexAccounts.listAccounts())
  registerAppHandler('codexAccounts:add', (_event, args?: CodexAccountAddTarget) =>
    codexAccounts.addAccount(args)
  )
  registerAppHandler('codexAccounts:cancelPendingLogin', () => codexAccounts.cancelPendingLogin())
  registerAppHandler('codexAccounts:pendingLoginUrl', () => codexAccounts.getPendingLoginUrl())
  // Settings reads the current link on mount; broadcasts carry later changes.
  codexAccounts.onPendingLoginUrlChanged(broadcastCodexPendingLoginUrl)
  codexAccounts.setWslLoginUrlOpener((url) => openAccountSignInLink('codex', url))
  registerAppHandler(
    'codexAccounts:reauthenticate',
    (_event, args: { accountId: string; activateIfSelectionWasEmpty?: boolean }) =>
      codexAccounts.reauthenticateAccount(args.accountId, {
        activateIfSelectionWasEmpty: args.activateIfSelectionWasEmpty === true
      })
  )
  registerAppHandler('codexAccounts:remove', (_event, args: { accountId: string }) =>
    codexAccounts.removeAccount(args.accountId)
  )
  registerAppHandler(
    'codexAccounts:rename',
    (_event, args: { accountId: string; displayName: string | null }) =>
      codexAccounts.renameAccount(args.accountId, args.displayName)
  )
  registerAppHandler(
    'codexAccounts:select',
    (_event, args: { accountId: string | null } & CodexAccountSelectionTarget) => {
      if (!args.runtime) {
        // Legacy renderers omit runtime; infer it from the account so valid WSL selection still works.
        return codexAccounts.selectAccount(args.accountId)
      }
      return codexAccounts.selectAccountForTarget(args.accountId, args)
    }
  )
}
