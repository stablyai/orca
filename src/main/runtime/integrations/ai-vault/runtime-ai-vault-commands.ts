import type {
  ConversationKnowledgeIndexStatus,
  ConversationKnowledgeItem,
  ConversationKnowledgeListResult,
  GenerateConversationKnowledgeRequest,
  StartConversationKnowledgeIndexRequest
} from '../../../../shared/conversation-knowledge-items'
import type {
  AiVaultHistoryReadResult,
  AiVaultHistorySearchResult
} from '../../../../shared/ai-vault-history-types'
import type { AiVaultAgent } from '../../../../shared/ai-vault/contracts/ai-vault-types'
import { searchConversationKnowledgeItems } from '../../../../shared/conversation-knowledge-items'
import { readAiVaultHistorySession, searchAiVaultHistory } from '../../../ai-vault/session-history'
import { getConversationKnowledgeService } from '../../../ai-vault/conversation-knowledge-service-registry'
import type { CommitMessageAgentEnvironmentResolvers } from '../../../text-generation/execution/commit-message-agent-environment'
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
import { listAiVaultSessions } from '../../../ai-vault/listing/cached-session-list'
import { deleteAiVaultSessionForRemoteClient } from '../../../ai-vault/deletion/host-session-delete'
import type {
  AiVaultDeleteSessionArgs,
  AiVaultDeleteSessionResult
} from '../../../../shared/ai-vault/contracts/ai-vault-session-deletion'
import { resolveLocalAiVaultSessionTitles } from '../../../ai-vault/session-titles/session-title-resolver'

export class RuntimeAiVaultCommands {
  constructor(
    private readonly getPrepareResume: () =>
      | ((args: AiVaultPrepareSessionResumeArgs) => Promise<AiVaultPrepareSessionResumeResult>)
      | null,
    private readonly getEnvironmentResolvers: () =>
      | CommitMessageAgentEnvironmentResolvers
      | undefined = () => undefined
  ) {}

  list(args?: AiVaultListArgs, signal?: AbortSignal): Promise<AiVaultListResult> {
    return listAiVaultSessions(args, { signal })
  }

  searchHistory(args: {
    query: string
    limit?: number
    scopePaths?: readonly string[]
  }): Promise<AiVaultHistorySearchResult> {
    return searchAiVaultHistory(args)
  }

  readHistory(args: {
    agent: AiVaultAgent
    sessionId: string
    limit?: number
  }): Promise<AiVaultHistoryReadResult> {
    return readAiVaultHistorySession(args)
  }

  async listKnowledge(args?: {
    query?: string
    scopePaths?: string[]
  }): Promise<ConversationKnowledgeListResult> {
    const items = await this.knowledgeService().list(args?.scopePaths)
    return { items: searchConversationKnowledgeItems(items, args?.query ?? '') }
  }

  enrichKnowledge(args: GenerateConversationKnowledgeRequest): Promise<ConversationKnowledgeItem> {
    return this.knowledgeService().generate(args)
  }

  startKnowledgeIndex(
    args: StartConversationKnowledgeIndexRequest
  ): Promise<ConversationKnowledgeIndexStatus> {
    return this.knowledgeService().startIndex(args)
  }

  getKnowledgeIndexStatus(): ConversationKnowledgeIndexStatus {
    return this.knowledgeService().getIndexStatus()
  }

  cancelKnowledgeIndex(): void {
    this.knowledgeService().cancelIndex()
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

  private knowledgeService() {
    return getConversationKnowledgeService({
      userDataPath: getAppEnvironment().getPath('userData'),
      getEnvironmentResolvers: this.getEnvironmentResolvers
    })
  }
}
import { getAppEnvironment } from '../../../../shared/app-lifecycle/app-environment'
