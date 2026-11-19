import type { Store } from '../../persistence/loading-store/store'
import { localAiVaultSessionRootDirs } from '../../ai-vault/discovery/ai-vault-scan-roots'
import type { CodexRuntimeHomeService } from '../../codex-accounts/runtime-home-service'
import type { ClaudeRuntimeAuthService } from '../../claude-accounts/runtime-auth-service'
import { folderIdOfSelector } from '../../../shared/workspace/identity/workspace-scope'
import { splitWorktreeIdForFilesystem } from '../../../shared/worktree/id'
import { effectiveWorkspaceAccountId } from '../../../shared/agent-accounts/workspace-account-binding'
import { join } from 'node:path'
import { getProfileUserDataPath } from '../../orca-profiles/profile-storage-paths'
import { HistoryContinuationLedger } from './history-continuation-ledger'
import { HistoryResumePlanner } from './history-resume-planner'
import type {
  ClaudeRateLimitAccountsState,
  CodexRateLimitAccountsState
} from '../../../shared/agent-accounts/managed-account-types'
import {
  WorkspaceAccountSessionResume,
  installWorkspaceAccountSessionResume
} from './workspace-account-session-resume'

export function installProviderWorkspaceSessionResume(
  store: Store,
  codex: CodexRuntimeHomeService,
  claude: ClaudeRuntimeAuthService,
  rosters: { codex(): CodexRateLimitAccountsState; claude(): ClaudeRateLimitAccountsState }
): void {
  const workspacePath = (id: string): string | undefined => {
    const folderId = folderIdOfSelector(id)
    if (folderId) {
      return store.getFolderWorkspace(folderId)?.folderPath
    }
    const worktree = splitWorktreeIdForFilesystem(id)
    return worktree && store.getRepo(worktree.repoId) ? worktree.worktreePath : undefined
  }
  installWorkspaceAccountSessionResume(
    new WorkspaceAccountSessionResume(
      new HistoryResumePlanner({
        ledger: new HistoryContinuationLedger(
          join(getProfileUserDataPath(), 'history-continuations.json')
        ),
        roots: localAiVaultSessionRootDirs,
        workspacePath,
        accounts: (provider, workspaceId) => {
          const settings = store.getSettings()
          const roster = rosters[provider]()
          const email =
            provider === 'codex'
              ? rosters.codex().systemDefault?.email
              : rosters.claude().systemDefaultEmail
          return {
            workspaceAccountId: effectiveWorkspaceAccountId(
              provider === 'codex'
                ? settings.codexWorkspaceAccounts
                : settings.claudeWorkspaceAccounts,
              workspaceId,
              roster.activeAccountIdsByRuntime
                ? roster.activeAccountIdsByRuntime.host
                : roster.activeAccountId
            ),
            accounts: [
              {
                id: null,
                label: email ? `System default · ${email}` : 'System default',
                available: true
              },
              ...roster.accounts.map((account) => {
                const name = settings.managedAccountDisplayNames?.[provider]?.[account.id]
                return {
                  id: account.id,
                  label: name ? `${name} · ${account.email}` : account.email,
                  available:
                    provider === 'codex'
                      ? !('managedHomeRuntime' in account && account.managedHomeRuntime === 'wsl')
                      : !(
                          'managedAuthRuntime' in account && account.managedAuthRuntime === 'wsl'
                        ) && !('needsSignIn' in account && account.needsSignIn)
                }
              })
            ]
          }
        },
        prepareAccount: async (provider, accountId) => {
          if (provider === 'codex') {
            return codex.prepareHistoryAccountHome(accountId)
          }
          if (accountId === null) {
            return claude.router.systemDefaultHome()
          }
          return (await claude.prepareAccountFolder(accountId, { runtime: 'host' })).configDir
        }
      })
    )
  )
}
