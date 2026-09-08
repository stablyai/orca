import type { AiVaultListResult, AiVaultSession } from '../../../../shared/ai-vault-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import type {
  MobileAiVaultResumeLaunch,
  MobileAiVaultResumeSettings
} from '../../../../shared/mobile-ai-vault-resume-launch-plan'
import type {
  MobileAiVaultResumeFolderWorkspace,
  MobileAiVaultResumeProjectGroup,
  MobileAiVaultResumeRepo
} from '../../../../shared/mobile-ai-vault-resume-host-status'
import type { MobileAiVaultWorktree } from '../../../../shared/mobile-ai-vault-session-worktree'
import { assertLegacyAiVaultResumeCommandAllowed } from '../../../ai-vault/structured-session-ownership'
import type { RpcContext } from '../core'

const RESUME_WORKTREE_LIMIT = 10_000
const AI_VAULT_SESSION_LIMIT = 500

export type MobileWebAgentHistoryWorktree = MobileAiVaultWorktree & {
  displayName?: string
  workspaceKind?: 'git' | 'folder-workspace'
  terminalPlatform?: NodeJS.Platform
}

/** One place naming every runtime call the agent-history methods make. Each is the same typed
 *  function the equivalent RPC method handler calls, so no result is re-parsed on the way in. */
export function mobileWebAgentHistoryRpc(context: RpcContext) {
  const runtime = context.runtime
  return {
    async worktrees(): Promise<MobileWebAgentHistoryWorktree[]> {
      const result = await runtime.getWorktreePs(RESUME_WORKTREE_LIMIT, true)
      return result.worktrees
    },
    repos(): MobileAiVaultResumeRepo[] {
      runtime.enrichMissingRepoGitRemoteIdentities?.()
      return runtime.listRepos()
    },
    projectGroups(): MobileAiVaultResumeProjectGroup[] {
      return runtime.listProjectGroups()
    },
    folderWorkspaces(): MobileAiVaultResumeFolderWorkspace[] {
      return runtime.listFolderWorkspaces()
    },
    settings(): MobileAiVaultResumeSettings | null {
      return runtime.getClientSettings() ?? null
    },
    status(): { platform: NodeJS.Platform | null; terminalWindowsShell: string | null } {
      const status = runtime.getStatus()
      return {
        platform: status.hostPlatform ?? null,
        terminalWindowsShell: status.terminalWindowsShell?.trim()
          ? status.terminalWindowsShell
          : null
      }
    },
    async sessions(args: {
      force: boolean
      scopePaths: readonly string[]
    }): Promise<AiVaultListResult> {
      await runtime.ensureStructuredAgentSessionHost()
      return runtime.listAiVaultSessions({
        limit: AI_VAULT_SESSION_LIMIT,
        force: args.force,
        scopePaths: [...args.scopePaths]
      })
    },
    async prepareResume(
      session: AiVaultSession
    ): Promise<{ useRealCodexHome?: boolean; substituteCodexHome?: string | null }> {
      await runtime.ensureStructuredAgentSessionHost()
      // The transcript's owning host prepares it; a client stamp must never cross that boundary.
      return runtime.prepareAiVaultSessionResume({
        agent: session.agent,
        ...(session.sessionId ? { sessionId: session.sessionId } : {}),
        filePath: session.filePath,
        codexHome: session.codexHome,
        executionHostId: LOCAL_EXECUTION_HOST_ID
      })
    },
    async createTerminal(
      worktreeId: string,
      launch: MobileAiVaultResumeLaunch & { clientMutationId: string }
    ): Promise<string> {
      // Keep command delivery inside the create operation so its retry dedup covers both.
      await assertLegacyAiVaultResumeCommandAllowed(launch.command, () =>
        runtime.ensureStructuredAgentSessionHost()
      )
      const created = await runtime.createMobileSessionTerminal(`id:${worktreeId}`, {
        command: launch.command,
        startupCommandDelivery: 'shell-ready',
        ...(launch.env ? { env: launch.env } : {}),
        ...(launch.envToDelete ? { envToDelete: launch.envToDelete } : {}),
        ...(launch.launchConfig ? { launchConfig: launch.launchConfig } : {}),
        ...(launch.launchAgent ? { launchAgent: launch.launchAgent } : {}),
        clientMutationId: launch.clientMutationId,
        clientNavigationId: context.pairedDeviceId,
        signal: context.signal,
        activate: false,
        select: true,
        navigation: 'caller'
      })
      const terminal = created.tab?.terminal
      if (!terminal) {
        throw new Error('runtime_unavailable')
      }
      return terminal
    }
  }
}
