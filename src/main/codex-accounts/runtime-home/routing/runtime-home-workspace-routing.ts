import { codexWorkspaceAccountId } from '../../../../shared/agent-accounts/codex/codex-workspace-account'
import type { CodexManagedAccount } from '../../../../shared/agent-accounts/managed-account-types'
import type { CodexAccountSelectionTarget } from '../../../../shared/agent-accounts/codex/codex-selection-lane'
import { CodexRuntimeHomeRouting } from './runtime-home-service-home-routing'

export abstract class CodexRuntimeHomeWorkspaceRouting extends CodexRuntimeHomeRouting {
  protected workspaceAccount(
    workspaceId?: string,
    target?: CodexAccountSelectionTarget
  ): CodexManagedAccount | null {
    const settings = this.store.getSettings()
    const id = codexWorkspaceAccountId(settings.codexWorkspaceAccounts, workspaceId)
    if (!id) {
      return null
    }
    const account = settings.codexManagedAccounts.find((entry) => entry.id === id)
    if (!account) {
      throw new Error(
        'The Codex account assigned to this workspace was removed. Choose another account.'
      )
    }
    if ((account.managedHomeRuntime === 'wsl') !== (target?.runtime === 'wsl')) {
      return null
    }
    return account
  }

  protected workspaceAccountHome(
    account: CodexManagedAccount,
    target?: CodexAccountSelectionTarget
  ): string {
    if (target?.runtime === 'wsl') {
      const distro = this.resolveWslDefaultTarget(target).wslDistro?.trim()
      const home = this.getWslLaunchCodexHomePath(account, distro)
      if (home) {
        return home
      }
      throw new Error('The workspace Codex account belongs to a different host or WSL distro.')
    }
    if (account.managedHomeRuntime === 'wsl') {
      throw new Error('A WSL Codex account cannot launch on this host.')
    }
    const resolved = this.resolveSelfContainedManagedHome(account)
    if (resolved.kind !== 'owned') {
      throw new Error(
        'The workspace Codex account home is unavailable. Sign in again or choose another account.'
      )
    }
    return resolved.homePath
  }
}
