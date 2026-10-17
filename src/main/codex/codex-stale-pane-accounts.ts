import type { GlobalSettings } from '../../shared/global-settings-types'
import { getSelectedCodexAccountIdForTarget } from '../codex-accounts/runtime-selection'
import {
  forgetCodexPaneAccount,
  getCodexPaneAccount,
  listRecordedCodexPaneAccounts,
  setCodexPaneKept,
  type CodexPaneAccountRecord
} from './codex-pane-account-registry'

export type StaleCodexPane = {
  ptyId: string
  launchAccountId: string | null
  activeAccountId: string | null
}

/**
 * Reports which of the given PTYs still launch Codex as a previously selected
 * account, so the restart prompt survives an app restart the shells outlive.
 * Why only the account: a pane on an older Codex home keeps working, refreshed from ~/.codex.
 */
export function listStaleCodexPanes(args: {
  ptyIds: readonly string[]
  settings: GlobalSettings
}): StaleCodexPane[] {
  const stalePanes: StaleCodexPane[] = []
  const records = listRecordedCodexPaneAccounts(args.ptyIds)
  for (const ptyId of args.ptyIds) {
    const record = records.get(ptyId)
    // Why: a kept pane stays on its account by choice, so it is never stale.
    if (!record || record.kept) {
      continue
    }
    const activeAccountId = getSelectedCodexAccountIdForTarget(
      args.settings,
      parseSelectionLaneKey(record.selectionKey)
    )
    if (record.accountId !== activeAccountId) {
      stalePanes.push({ ptyId, launchAccountId: record.accountId, activeAccountId })
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

/** Only a pane's own home can stay on its account; the shared home mirrors the selection, WSL's the distro's. */
export function isCodexPaneKeepable(record: CodexPaneAccountRecord): boolean {
  return (
    record.selectionKey === 'host' &&
    (record.homeRoute === 'account-home' || record.homeRoute === 'real-home')
  )
}

/** "Keep old account": keeps each keepable pane and forgets the rest as before; returns the kept ids. */
export function keepStaleCodexPanes(ptyIds: readonly string[]): string[] {
  const kept: string[] = []
  for (const ptyId of ptyIds) {
    const record = getCodexPaneAccount(ptyId)
    if (record && isCodexPaneKeepable(record) && setCodexPaneKept(ptyId, true) === 'kept') {
      kept.push(ptyId)
      continue
    }
    forgetStaleCodexPanes([ptyId])
  }
  return kept
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
