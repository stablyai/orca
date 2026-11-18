import { codexWorkspaceAccountId } from '../../../../shared/agent-accounts/codex/codex-workspace-account'
import type { GlobalSettings } from '../../../../shared/settings/global-settings-types'
import { getSelectedCodexAccountIdForTarget } from '../../../codex-accounts/account-management/runtime-selection'
import {
  forgetCodexPaneAccount,
  listRecordedCodexPaneAccounts
} from './codex-pane-account-registry'

export type StaleCodexPane = {
  ptyId: string
  launchAccountId: string | null
  activeAccountId: string | null
}

// Only account changes need prompts; older runtime homes remain usable.
export function listStaleCodexPanes(args: {
  ptyIds: readonly string[]
  settings: GlobalSettings
}): StaleCodexPane[] {
  const stalePanes: StaleCodexPane[] = []
  const records = listRecordedCodexPaneAccounts(args.ptyIds)
  for (const ptyId of args.ptyIds) {
    const record = records.get(ptyId)
    if (!record || record.pinnedByResume) {
      continue
    }
    const lane = parseSelectionLaneKey(record.selectionKey)
    const workspaceId = codexWorkspaceAccountId(
      args.settings.codexWorkspaceAccounts,
      record.workspaceId
    )
    const workspace = args.settings.codexManagedAccounts.find(
      (account) => account.id === workspaceId
    )
    const matches =
      workspace &&
      (workspace.managedHomeRuntime === 'wsl') === (lane.runtime === 'wsl') &&
      (lane.runtime !== 'wsl' ||
        workspace.wslDistro?.toLowerCase() === lane.wslDistro?.toLowerCase())
    const activeAccountId =
      (matches ? workspaceId : undefined) ?? getSelectedCodexAccountIdForTarget(args.settings, lane)
    if (record.accountId !== activeAccountId) {
      stalePanes.push({ ptyId, launchAccountId: record.accountId, activeAccountId })
    }
  }
  return stalePanes
}

/** Persist dismissal so keeping an old account does not prompt again after restart. */
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
  // Decode the default-distro sentinel from getCodexSelectionLaneKey.
  return { runtime: 'wsl', wslDistro: distro === '__default__' ? null : distro }
}
