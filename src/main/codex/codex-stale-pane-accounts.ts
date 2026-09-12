import type { GlobalSettings } from '../../shared/global-settings-types'
import { getSelectedCodexAccountIdForTarget } from '../codex-accounts/runtime-selection'
import {
  forgetCodexPaneAccount,
  listRecordedCodexPaneAccounts,
  type CodexPaneHomeRoute
} from './codex-pane-account-registry'

export type StaleCodexPane = {
  ptyId: string
  launchAccountId: string | null
  activeAccountId: string | null
  reason: 'account-change' | 'home-route-change'
}

/**
 * Reports which of the given PTYs still launch Codex as a previously selected
 * account, so the restart prompt survives an app restart the shells outlive.
 */
export function listStaleCodexPanes(args: {
  ptyIds: readonly string[]
  settings: GlobalSettings
  activeHostHomeRoute?: CodexPaneHomeRoute
}): StaleCodexPane[] {
  const stalePanes: StaleCodexPane[] = []
  const records = listRecordedCodexPaneAccounts(args.ptyIds)
  for (const ptyId of args.ptyIds) {
    const record = records.get(ptyId)
    if (!record) {
      continue
    }
    const activeAccountId = getSelectedCodexAccountIdForTarget(
      args.settings,
      parseSelectionLaneKey(record.selectionKey)
    )
    const homeRouteChanged =
      record.selectionKey === 'host' &&
      record.homeRoute !== undefined &&
      record.homeRoute !== 'custom-home' &&
      args.activeHostHomeRoute !== undefined &&
      record.homeRoute !== args.activeHostHomeRoute
    const accountChanged = record.accountId !== activeAccountId
    if (accountChanged || homeRouteChanged) {
      stalePanes.push({
        ptyId,
        launchAccountId: record.accountId,
        activeAccountId,
        reason: accountChanged ? 'account-change' : 'home-route-change'
      })
    }
  }
  return stalePanes
}

/**
 * Drops the launch record for panes the user chose to keep on the old account.
 *
 * Why: keeping the old account is an answer to the prompt, but the record is
 * what the startup sweep re-raises from — without this the same dismissed pane
 * is prompted again (and has its input blocked again) after every app restart.
 */
export function forgetStaleCodexPanes(ptyIds: readonly string[]): void {
  for (const ptyId of ptyIds) {
    forgetCodexPaneAccount(ptyId)
  }
}

function parseSelectionLaneKey(selectionKey: string): {
  runtime: 'host' | 'wsl'
  wslDistro: string | null
} {
  if (!selectionKey.startsWith('wsl:')) {
    return { runtime: 'host', wslDistro: null }
  }
  const distro = selectionKey.slice('wsl:'.length)
  // Why: the lane key round-trips through getCodexSelectionLaneKey, whose
  // default-distro sentinel must resolve back to "no specific distro".
  return { runtime: 'wsl', wslDistro: distro === '__default__' ? null : distro }
}
