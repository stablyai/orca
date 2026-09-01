import type { RpcClient } from '../transport/rpc-client'
import type { Worktree } from '../worktree/workspace-list-types'
import type { MobileAiVaultResumeSettings } from '../session/ai-vault-resume-launch'
import { RESUME_RPC_TIMEOUT_MS } from '../session/ai-vault-resume-preparation'
import { hostSupportsAgentLaunchIdentity } from '../session/agent-launch-identity-capability'
import type {
  MobileAiVaultResumeFolderWorkspace,
  MobileAiVaultResumeProjectGroup,
  MobileAiVaultResumeRepo
} from './agent-history-resume-target'

export type MobileResumeMetadata = {
  repos: MobileAiVaultResumeRepo[]
  folderWorkspaces: MobileAiVaultResumeFolderWorkspace[]
  projectGroups: MobileAiVaultResumeProjectGroup[]
  settings: MobileAiVaultResumeSettings | null
  worktrees: Worktree[] | null
  hasIdentityCapability: boolean
}

export async function loadMobileResumeMetadata(
  client: Pick<RpcClient, 'sendRequest'>
): Promise<MobileResumeMetadata> {
  // Why: repo.list can enrich repo remote identities, so fetch resume-only
  // metadata after explicit user intent instead of delaying history browsing.
  // timeoutMs: without it a socket drop parks these on the reconnect waiter
  // for minutes, pinning the resume spinner (see RESUME_RPC_TIMEOUT_MS).
  const [
    repoResponse,
    folderWorkspaceResponse,
    projectGroupResponse,
    settingsResponse,
    worktreeResponse,
    statusResponse
  ] = await Promise.all([
    client.sendRequest('repo.list', undefined, { timeoutMs: RESUME_RPC_TIMEOUT_MS }),
    client
      .sendRequest('folderWorkspace.list', undefined, { timeoutMs: RESUME_RPC_TIMEOUT_MS })
      .catch(() => null),
    client
      .sendRequest('projectGroup.list', undefined, { timeoutMs: RESUME_RPC_TIMEOUT_MS })
      .catch(() => null),
    client
      .sendRequest(
        'settings.get',
        // Resume reads only `settings`; the catalog comes from settings.agentCatalog.get.
        { includeAgentCatalog: false },
        { timeoutMs: RESUME_RPC_TIMEOUT_MS }
      )
      .catch(() => null),
    client
      .sendRequest('worktree.ps', { limit: 10000 }, { timeoutMs: RESUME_RPC_TIMEOUT_MS })
      .catch(() => null),
    // Why: gate the host-owned resume arm; a pre-identity host strips it and would
    // silently open a bare terminal. A missing/failed probe reads as unsupported,
    // so we degrade to the client-assembled resume every host still accepts.
    client
      .sendRequest('status.get', undefined, { timeoutMs: RESUME_RPC_TIMEOUT_MS })
      .catch(() => null)
  ])
  if (!repoResponse.ok) {
    throw new Error(repoResponse.error?.message || 'Unable to load workspace metadata.')
  }
  const repoResult = repoResponse.result as { repos?: MobileAiVaultResumeRepo[] }
  const folderWorkspaceResult =
    folderWorkspaceResponse?.ok === true
      ? (folderWorkspaceResponse.result as {
          folderWorkspaces?: MobileAiVaultResumeFolderWorkspace[]
        })
      : null
  const projectGroupResult =
    projectGroupResponse?.ok === true
      ? (projectGroupResponse.result as { groups?: MobileAiVaultResumeProjectGroup[] })
      : null
  const settingsResult =
    settingsResponse?.ok === true
      ? (settingsResponse.result as { settings?: MobileAiVaultResumeSettings })
      : null
  const worktreeResult =
    worktreeResponse?.ok === true ? (worktreeResponse.result as { worktrees?: Worktree[] }) : null
  return {
    repos: repoResult.repos ?? [],
    folderWorkspaces: folderWorkspaceResult?.folderWorkspaces ?? [],
    projectGroups: projectGroupResult?.groups ?? [],
    settings: settingsResult?.settings ?? null,
    worktrees: worktreeResult?.worktrees ?? null,
    hasIdentityCapability:
      statusResponse?.ok === true && hostSupportsAgentLaunchIdentity(statusResponse.result)
  }
}
