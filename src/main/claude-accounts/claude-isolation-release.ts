import type { GlobalSettings } from '../../shared/global-settings-types'
import type { ClaudeAccountSelectionTarget } from './runtime-selection'
import { normalizeClaudeRuntimeSelection } from './runtime-selection'

type SelectionSettings = Pick<
  GlobalSettings,
  'activeClaudeManagedAccountId' | 'activeClaudeManagedAccountIdsByRuntime'
>

export type ClaudeIsolationReleaseDeps = {
  getSettings: () => SelectionSettings
  deselect: (target: ClaudeAccountSelectionTarget) => Promise<unknown>
  hasMaterializedManagedLogin: () => boolean
}

// Why verify afterwards: a sync that skipped its restore looks like success, and would leave a
// managed login in ~/.claude while isolation reports it is in effect.
export async function releaseManagedClaudeSelections(
  deps: ClaudeIsolationReleaseDeps
): Promise<void> {
  const selection = normalizeClaudeRuntimeSelection(deps.getSettings())
  if (selection.host) {
    await deps.deselect({ runtime: 'host' })
  }
  for (const [wslDistro, accountId] of Object.entries(selection.wsl ?? {})) {
    if (accountId) {
      await deps.deselect({ runtime: 'wsl', wslDistro })
    }
  }
  if (deps.hasMaterializedManagedLogin()) {
    throw new Error('A managed Claude login is still materialized in the Claude CLI config.')
  }
}
