import { optionalSettingsRead } from '../transport/settings-read-operations'
import { interpretOrThrowRefusalMessage } from '../transport/rpc-refusal-message'
import { rpcPayloadMember } from '../transport/rpc-reader-payload'
import { readAcceptedResumeList } from './resume-metadata-lists'
import {
  resumeFolderWorkspaceListRead,
  resumeProjectGroupListRead,
  resumeRepoListRead,
  resumeWorktreeListRead
} from './mobile-agent-history-operations'
import type { RpcClient } from '../transport/rpc-client'
import type { Worktree } from '../worktree/workspace-list-types'
import type { MobileAiVaultResumeSettings } from '../session/ai-vault-resume-launch'
import { RESUME_RPC_TIMEOUT_MS } from '../session/ai-vault-resume-preparation'
import type {
  MobileAiVaultResumeRepo,
  MobileAiVaultResumeFolderWorkspace,
  MobileAiVaultResumeProjectGroup
} from './agent-history-resume-target'

export async function loadMobileResumeMetadata(client: RpcClient): Promise<{
  repos: MobileAiVaultResumeRepo[]
  folderWorkspaces: MobileAiVaultResumeFolderWorkspace[]
  projectGroups: MobileAiVaultResumeProjectGroup[]
  settings: MobileAiVaultResumeSettings | null
  worktrees: Worktree[] | null
}> {
  // Why: repo.list can enrich repo remote identities, so fetch resume-only
  // metadata after explicit user intent instead of delaying history browsing.
  // timeoutMs: without it a socket drop parks these on the reconnect waiter
  // for minutes, pinning the resume spinner (see RESUME_RPC_TIMEOUT_MS).
  const [repoReply, folderWorkspaceReply, projectGroupReply, settingsReply, worktreeReply] =
    await Promise.all([
      resumeRepoListRead.request(client, undefined, { timeoutMs: RESUME_RPC_TIMEOUT_MS }),
      resumeFolderWorkspaceListRead
        .request(client, undefined, { timeoutMs: RESUME_RPC_TIMEOUT_MS })
        .catch(() => null),
      resumeProjectGroupListRead
        .request(client, undefined, { timeoutMs: RESUME_RPC_TIMEOUT_MS })
        .catch(() => null),
      optionalSettingsRead
        .request(client, undefined, { timeoutMs: RESUME_RPC_TIMEOUT_MS })
        .catch(() => null),
      resumeWorktreeListRead
        .request(client, { limit: 10000 }, { timeoutMs: RESUME_RPC_TIMEOUT_MS })
        .catch(() => null)
    ])
  const repoResult = interpretOrThrowRefusalMessage(
    () => resumeRepoListRead.interpret(repoReply),
    'Unable to load workspace metadata.'
  )
  const folderWorkspaceResult =
    folderWorkspaceReply && resumeFolderWorkspaceListRead.interpret(folderWorkspaceReply)
  const projectGroupResult =
    projectGroupReply && resumeProjectGroupListRead.interpret(projectGroupReply)
  const settingsResult = settingsReply ? optionalSettingsRead.interpret(settingsReply) : null
  const settings = settingsResult?.accepted
    ? // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Preserve the established response shape at this boundary.
      (settingsResult.value as MobileAiVaultResumeSettings | null | undefined)
    : null
  const worktreeResult = worktreeReply && resumeWorktreeListRead.interpret(worktreeReply)
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Preserve the established response shape at this boundary.
    repos: (rpcPayloadMember(repoResult, 'repos') as MobileAiVaultResumeRepo[] | undefined) ?? [],
    folderWorkspaces: readAcceptedResumeList(folderWorkspaceResult, 'folderWorkspaces') ?? [],
    projectGroups: readAcceptedResumeList(projectGroupResult, 'groups') ?? [],
    settings: settings ?? null,
    worktrees: readAcceptedResumeList(worktreeResult, 'worktrees') ?? null
  }
}
