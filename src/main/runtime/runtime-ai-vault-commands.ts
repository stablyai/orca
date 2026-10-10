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
import { listSshHostScopeAiVaultSessions } from '../host/ai-vault-ssh-host-port'
import { parseExecutionHostId } from '../../shared/execution-host'
import { resolveLocalAiVaultSessionTitles } from '../ai-vault/session-title-resolver'

export class RuntimeAiVaultCommands {
  constructor(
    private readonly getPrepareResume: () =>
      | ((args: AiVaultPrepareSessionResumeArgs) => Promise<AiVaultPrepareSessionResumeResult>)
      | null
  ) {}

  list(args?: AiVaultListArgs): Promise<AiVaultListResult> {
    // Why: only a single SSH scope is routed here; every other value keeps the host-local scan
    // this method has always answered (the RPC schema never admits 'all' or runtime scopes).
    const scope = parseExecutionHostId(args?.executionHostScope)
    return scope?.kind === 'ssh'
      ? listSshHostScopeAiVaultSessions(scope.targetId, args)
      : listAiVaultSessions(args)
  }

  resolveTitles(
    requests: AiVaultSessionTitleRequest[],
    signal?: AbortSignal
  ): Promise<AiVaultSessionTitlesResult> {
    return resolveLocalAiVaultSessionTitles(requests, signal)
  }

  prepare(args: AiVaultPrepareSessionResumeArgs): Promise<AiVaultPrepareSessionResumeResult> {
    return this.getPrepareResume()?.(args) ?? Promise.resolve({ useRealCodexHome: false })
  }
}
