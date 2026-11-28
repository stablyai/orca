import type {
  AiVaultPrepareSessionResumeArgs,
  AiVaultPrepareSessionResumeResult
} from '../../../../shared/ai-vault/resume/ai-vault-resume-preparation'
import type {
  AiVaultSessionTitleRequest,
  AiVaultSessionTitlesResult
} from '../../../../shared/ai-vault/contracts/ai-vault-session-title'
import type {
  AiVaultListArgs,
  AiVaultListResult
} from '../../../../shared/ai-vault/contracts/ai-vault-types'
import type {
  AiVaultDeleteSessionArgs,
  AiVaultDeleteSessionResult
} from '../../../../shared/ai-vault/contracts/ai-vault-session-deletion'

export class RuntimeAiVaultCommands {
  constructor(
    private readonly getPrepareResume: () =>
      | ((args: AiVaultPrepareSessionResumeArgs) => Promise<AiVaultPrepareSessionResumeResult>)
      | null
  ) {}

  async list(args?: AiVaultListArgs, signal?: AbortSignal): Promise<AiVaultListResult> {
    const { listAiVaultSessions } = await import('../../../ai-vault/listing/cached-session-list')
    return listAiVaultSessions(args, { signal })
  }

  async resolveTitles(
    requests: AiVaultSessionTitleRequest[],
    signal?: AbortSignal
  ): Promise<AiVaultSessionTitlesResult> {
    const { resolveLocalAiVaultSessionTitles } =
      await import('../../../ai-vault/session-titles/session-title-resolver')
    return resolveLocalAiVaultSessionTitles(requests, signal)
  }

  async delete(
    args: Omit<AiVaultDeleteSessionArgs, 'executionHostId'>
  ): Promise<AiVaultDeleteSessionResult> {
    const { deleteAiVaultSessionForRemoteClient } =
      await import('../../../ai-vault/deletion/host-session-delete')
    return deleteAiVaultSessionForRemoteClient(args)
  }

  prepare(args: AiVaultPrepareSessionResumeArgs): Promise<AiVaultPrepareSessionResumeResult> {
    return this.getPrepareResume()?.(args) ?? Promise.resolve({ useRealCodexHome: false })
  }
}
