import type {
  AiVaultPrepareSessionResumeArgs,
  AiVaultPrepareSessionResumeResult
} from '../../shared/ai-vault-resume-preparation'
import type {
  AiVaultSessionTitleRequest,
  AiVaultSessionTitlesResult
} from '../../shared/ai-vault-session-title'
import type { AiVaultAgent, AiVaultListArgs, AiVaultListResult } from '../../shared/ai-vault-types'
import { listAiVaultSessions } from '../ai-vault/cached-session-list'
import {
  readAiVaultHistorySession,
  searchAiVaultHistory,
  type AiVaultHistoryReadResult,
  type AiVaultHistorySearchResult
} from '../ai-vault/session-history'
import { resolveLocalAiVaultSessionTitles } from '../ai-vault/session-title-resolver'
import type {
  ConversationKnowledgeIndexStatus,
  ConversationKnowledgeItem,
  ConversationKnowledgeListResult,
  GenerateConversationKnowledgeRequest,
  StartConversationKnowledgeIndexRequest
} from '../../shared/conversation-knowledge-items'
import { searchConversationKnowledgeItems } from '../../shared/conversation-knowledge-items'
import { getConversationKnowledgeService } from '../ai-vault/conversation-knowledge-service-registry'
import type { CommitMessageAgentEnvironmentResolvers } from '../text-generation/commit-message-agent-environment'

export class RuntimeAiVaultCommands {
  constructor(
    private readonly getPrepareResume: () =>
      | ((args: AiVaultPrepareSessionResumeArgs) => Promise<AiVaultPrepareSessionResumeResult>)
      | null,
    private readonly getUserDataPath: () => string,
    private readonly getEnvironmentResolvers: () =>
      | CommitMessageAgentEnvironmentResolvers
      | undefined
  ) {}

  list(args?: AiVaultListArgs): Promise<AiVaultListResult> {
    return listAiVaultSessions(args)
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

  prepare(args: AiVaultPrepareSessionResumeArgs): Promise<AiVaultPrepareSessionResumeResult> {
    return this.getPrepareResume()?.(args) ?? Promise.resolve({ useRealCodexHome: false })
  }

  private knowledgeService() {
    return getConversationKnowledgeService({
      userDataPath: this.getUserDataPath(),
      getEnvironmentResolvers: this.getEnvironmentResolvers
    })
  }
}
