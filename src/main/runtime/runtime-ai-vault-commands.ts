import type {
  AiVaultPrepareSessionResumeArgs,
  AiVaultPrepareSessionResumeResult
} from '../../shared/ai-vault-resume-preparation'
import type {
  AiVaultSessionTitleRequest,
  AiVaultSessionTitlesResult
} from '../../shared/ai-vault-session-title'
import type { AiVaultListArgs, AiVaultListResult } from '../../shared/ai-vault-types'
import { listAiVaultSessions } from '../ai-vault/cached-session-list'
import { deleteAiVaultSessionForRemoteClient } from '../ai-vault/host-session-delete'
import type {
  AiVaultDeleteSessionArgs,
  AiVaultDeleteSessionResult
} from '../../shared/ai-vault-session-deletion'
import { resolveLocalAiVaultSessionTitles } from '../ai-vault/session-title-resolver'

export class RuntimeAiVaultCommands {
  constructor(
    private readonly getPrepareResume: () =>
      | ((args: AiVaultPrepareSessionResumeArgs) => Promise<AiVaultPrepareSessionResumeResult>)
      | null
  ) {}

  list(args?: AiVaultListArgs, signal?: AbortSignal): Promise<AiVaultListResult> {
    return listAiVaultSessions(args, { signal })
  }

  resolveTitles(
    requests: AiVaultSessionTitleRequest[],
    signal?: AbortSignal
  ): Promise<AiVaultSessionTitlesResult> {
    return resolveLocalAiVaultSessionTitles(requests, signal)
  }

  delete(
    args: Omit<AiVaultDeleteSessionArgs, 'executionHostId'>
  ): Promise<AiVaultDeleteSessionResult> {
    return deleteAiVaultSessionForRemoteClient(args)
  }

  prepare(args: AiVaultPrepareSessionResumeArgs): Promise<AiVaultPrepareSessionResumeResult> {
    return this.getPrepareResume()?.(args) ?? Promise.resolve({ useRealCodexHome: false })
  }
}
