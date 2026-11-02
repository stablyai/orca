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
import type { AiVaultResumeLaunchSettings } from '../../../src/shared/ai-vault-resume-startup'
import { RESUME_RPC_TIMEOUT_MS } from '../session/ai-vault-resume-preparation'
import type { MobileAiVaultResumeCatalog } from './agent-history-resume-target'

type ResumeRepos = MobileAiVaultResumeCatalog['repos']

export async function loadMobileResumeMetadata(client: RpcClient): Promise<
  MobileAiVaultResumeCatalog & {
    settings: AiVaultResumeLaunchSettings | null
    worktrees: Worktree[] | null
  }
> {
  // Fetch repo-enriching metadata only on resume intent; RESUME_RPC_TIMEOUT_MS prevents dropped sockets parking spinner on multi-minute reconnect waiter.
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
      (settingsResult.value as AiVaultResumeLaunchSettings | null | undefined)
    : null
  const worktreeResult = worktreeReply && resumeWorktreeListRead.interpret(worktreeReply)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Preserve the established response shape at this boundary.
  const repos = rpcPayloadMember(repoResult, 'repos') as ResumeRepos | undefined
  return {
    repos: repos ?? [],
    folderWorkspaces: readAcceptedResumeList(folderWorkspaceResult, 'folderWorkspaces') ?? [],
    projectGroups: readAcceptedResumeList(projectGroupResult, 'groups') ?? [],
    settings: settings ?? null,
    worktrees: readAcceptedResumeList(worktreeResult, 'worktrees') ?? null
  }
}
