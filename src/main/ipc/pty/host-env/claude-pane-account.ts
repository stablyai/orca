import type { GlobalSettings } from '../../../../shared/global-settings-types'
import {
  forgetClaudePaneAccount,
  recordClaudePaneAccount
} from '../../../claude-accounts/claude-pane-account-registry'
import type { ClaudeRuntimeAuthPreparation } from '../../../claude-accounts/runtime-auth-service'
import {
  getSelectedClaudeAccountIdForTarget,
  type ClaudeAccountSelectionTarget
} from '../../../claude-accounts/runtime-selection'

const REJECTED_PROFILE_IDS = new Set(['unavailable', 'undefined', 'null'])

type ClaudePaneAccountSettings = Partial<
  Pick<GlobalSettings, 'activeClaudeManagedAccountId' | 'activeClaudeManagedAccountIdsByRuntime'>
>

/**
 * `profile:<id>` (or `profile:<id>:wsl:<distro>`) names the account; `system` (or `wsl:<distro>:system`) means System default,
 * which runs the named account when supplied, otherwise the selected account; anything else names no managed account.
 */
export function claudeAccountIdFromProvenance(
  provenance: string,
  settings: ClaudePaneAccountSettings | undefined,
  target: ClaudeAccountSelectionTarget,
  claudeAccountId?: string
): string | null {
  if (provenance.startsWith('profile:')) {
    const id = provenance.split(':')[1]
    // Why: upstream builds `profile:${profile?.accountId}`, so a missing id arrives as '' or the
    // literal 'undefined' / 'null'; none of those names an account.
    return id && !REJECTED_PROFILE_IDS.has(id) ? id : null
  }
  // Why: a System-default pane consumes the quota of the account System default covers, because
  // that login IS the account's; record that account, not "no account".
  // Why WSL too: a WSL System-default pane (`wsl:<distro>:system`) runs the selected WSL account the
  // same way the host one does; the caller's target is that WSL runtime.
  if (provenance === 'system' && claudeAccountId !== undefined) {
    return claudeAccountId
  }
  if (provenance === 'system' || /^wsl:[^:]+:system$/.test(provenance)) {
    return getSelectedClaudeAccountIdForTarget(settings ?? {}, target)
  }
  return null
}

/**
 * Records the account a Claude launch runs on; both spawn choke points (renderer pty:spawn and the
 * runtime controller) call this after the spawn committed and its pane key was remembered, so the
 * stored paneKey equals ptyPaneKey's.
 */
export function recordClaudePaneAccountForSpawn(args: {
  ptyId: string
  paneKey: string | null
  isClaudeLaunch: boolean
  isReattach: boolean
  claudeAuth: ClaudeRuntimeAuthPreparation | null
  claudeAccountId?: string
  settings: ClaudePaneAccountSettings | undefined
  target: ClaudeAccountSelectionTarget
  now?: number
}): void {
  // Why: a reattach inherits the baked environment; re-recording it under today's selection would
  // erase the account the launch recorded.
  if (args.isReattach) {
    return
  }
  if (!args.isClaudeLaunch || !args.claudeAuth) {
    forgetClaudePaneAccount(args.ptyId)
    return
  }
  const accountId = claudeAccountIdFromProvenance(
    args.claudeAuth.provenance,
    args.settings,
    args.target,
    args.claudeAccountId
  )
  if (!accountId) {
    forgetClaudePaneAccount(args.ptyId)
    return
  }
  recordClaudePaneAccount({
    ptyId: args.ptyId,
    paneKey: args.paneKey,
    accountId,
    configDir: args.claudeAuth.configDir || null,
    launchedAt: args.now ?? Date.now(),
    // Why false: Orca chose this folder; a session whose shell chose its own is learned from its
    // transcript later and marked pinned there.
    pinned: false,
    source: 'spawn'
  })
}
