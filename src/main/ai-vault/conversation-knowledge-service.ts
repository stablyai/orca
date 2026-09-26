import {
  isAiVaultSessionResumableContent,
  type AiVaultAgent,
  type AiVaultSession
} from '../../shared/ai-vault-types'
import {
  isConversationKnowledgeGenerationTitle,
  isConversationKnowledgeItemFresh,
  type ConversationKnowledgeIndexStatus,
  type ConversationKnowledgeItem
} from '../../shared/conversation-knowledge-items'
import type { TuiAgent } from '../../shared/tui-agent'
import { resolveConversationKnowledgeModel } from './session-enrichment'
import {
  conversationKnowledgeId,
  conversationPathIsWithin,
  isKnowledgeGenerationSession
} from './conversation-knowledge-source-session'
import { cancelLocalGeneration } from '../text-generation/source-control-generation-lanes'
import type { ConversationKnowledgeIndexCheckpoint } from './conversation-knowledge-index-checkpoint-store'
import {
  isCanceledConversationKnowledgeGeneration,
  readResumableConversationKnowledgeIndex,
  writeConversationKnowledgeIndexCheckpoint
} from './conversation-knowledge-index-checkpoint'
import { generateConversationKnowledgeFromSession } from './conversation-knowledge-session-processing'
import { listConversationKnowledge } from './conversation-knowledge-list'
import type { ConversationKnowledgeServiceDependencies } from './conversation-knowledge-service-dependencies'
const MAX_CONCURRENT_SUMMARIES = 1
const idleIndexStatus = (): ConversationKnowledgeIndexStatus => ({
  state: 'idle',
  total: 0,
  completed: 0,
  failed: 0
})
export type GenerateConversationKnowledgeArgs = {
  sourceAgent: AiVaultAgent
  sessionId: string
  generatorAgent: TuiAgent
  generatorModel?: string | null
  language?: string
}
export class ConversationKnowledgeService {
  private indexStatus = idleIndexStatus()
  private indexPromise: Promise<void> | null = null
  private indexConfig: string | null = null
  private cancelRequested = false
  private activeCwd: string | null = null
  private pendingSessions: readonly AiVaultSession[] = []
  private readonly restorePromise: Promise<void>
  constructor(private readonly dependencies: ConversationKnowledgeServiceDependencies) {
    this.restorePromise = this.restoreInterruptedIndex()
  }
  async generate(args: GenerateConversationKnowledgeArgs): Promise<ConversationKnowledgeItem> {
    const sessions = await this.dependencies.listSessions()
    const session = sessions.find(
      (candidate) => candidate.agent === args.sourceAgent && candidate.sessionId === args.sessionId
    )
    if (!session) {
      throw new Error('Source conversation was not found on this execution host.')
    }
    if (isKnowledgeGenerationSession(session)) {
      throw new Error('System-derived conversations cannot be indexed as knowledge sources.')
    }
    const item = await generateConversationKnowledgeFromSession({
      ...this.dependencies,
      session,
      args
    })
    if (!item) {
      throw new Error('Source conversation has no readable user or assistant messages.')
    }
    return item
  }
  async startIndex(args: {
    generatorAgent: TuiAgent
    generatorModel: string
    scopePaths?: string[]
    force?: boolean
    language?: string
    preserveExisting?: boolean
  }): Promise<ConversationKnowledgeIndexStatus> {
    await this.restorePromise
    const configKey = JSON.stringify({
      generatorAgent: args.generatorAgent,
      generatorModel: resolveConversationKnowledgeModel(args.generatorAgent, args.generatorModel),
      scopePaths: args.scopePaths ?? [],
      language: args.language ?? 'en'
    })
    const [sessions, storedItems] = await Promise.all([
      this.dependencies.listSessions(),
      this.dependencies.store.list()
    ])
    const generatedItemIds = storedItems
      .filter((item) => isConversationKnowledgeGenerationTitle(item.source.title))
      .map((item) => item.id)
    await this.dependencies.store.remove(generatedItemIds)
    const existingItems = generatedItemIds.length
      ? storedItems.filter((item) => !generatedItemIds.includes(item.id))
      : storedItems
    const sourceSessions = sessions.filter((session) => !isKnowledgeGenerationSession(session))
    const knownEmptyIds = new Set(
      sourceSessions
        .filter((session) => !isAiVaultSessionResumableContent(session))
        .map(conversationKnowledgeId)
    )
    await this.dependencies.store.remove(
      existingItems.filter((item) => knownEmptyIds.has(item.id)).map((item) => item.id)
    )
    const scopedSessions = sourceSessions.filter((session) => {
      if (!isAiVaultSessionResumableContent(session)) {
        return false
      }
      const cwd = session.cwd
      return (
        !args.scopePaths?.length ||
        (cwd !== null &&
          args.scopePaths.some((scopePath) => conversationPathIsWithin(scopePath, cwd)))
      )
    })
    const pendingSessions = scopedSessions.filter((session) => {
      if (args.force) {
        return true
      }
      const existing = existingItems.find(
        (item) =>
          item.source.executionHostId === session.executionHostId &&
          item.source.agent === session.agent &&
          item.source.sessionId === session.sessionId
      )
      return (
        !existing ||
        (!args.preserveExisting &&
          !isConversationKnowledgeItemFresh(existing, {
            sourceUpdatedAt: session.updatedAt,
            generatorAgent: args.generatorAgent,
            generatorModel: resolveConversationKnowledgeModel(
              args.generatorAgent,
              args.generatorModel
            )
          }))
      )
    })
    if (this.indexPromise) {
      if (this.indexConfig === configKey) {
        return this.indexStatus
      }
      const activeIndexPromise = this.indexPromise
      this.cancelIndex()
      return activeIndexPromise.then(() => this.startIndex({ ...args, preserveExisting: true }))
    }
    this.indexStatus = {
      state: pendingSessions.length ? 'running' : 'idle',
      total: pendingSessions.length,
      completed: 0,
      failed: 0
    }
    if (pendingSessions.length) {
      this.cancelRequested = false
      this.indexConfig = configKey
      this.pendingSessions = pendingSessions
      this.writeCheckpoint('running', args)
      this.indexPromise = this.runIndex(pendingSessions, args).finally(() => {
        this.indexStatus = { ...this.indexStatus, state: 'idle' }
        this.pendingSessions = []
        this.writeCheckpoint('stopped', args)
        this.indexPromise = null
        this.indexConfig = null
      })
    }
    return this.indexStatus
  }
  getIndexStatus = (): ConversationKnowledgeIndexStatus => this.indexStatus
  cancelIndex(): void {
    this.cancelRequested = true
    const canceled = Math.max(
      0,
      this.indexStatus.total -
        this.indexStatus.completed -
        this.indexStatus.failed -
        (this.indexStatus.canceled ?? 0)
    )
    this.indexStatus = {
      ...this.indexStatus,
      state: 'idle',
      canceled: (this.indexStatus.canceled ?? 0) + canceled
    }
    delete this.indexStatus.activeSession
    this.writeCheckpoint('stopped')
    if (this.activeCwd) {
      cancelLocalGeneration('knowledge-enrichment', this.activeCwd)
    }
  }
  private async runIndex(
    sessions: readonly AiVaultSession[],
    args: { generatorAgent: TuiAgent; generatorModel: string; language?: string }
  ): Promise<void> {
    let nextIndex = 0
    const worker = async (): Promise<void> => {
      while (nextIndex < sessions.length) {
        if (this.cancelRequested) {
          return
        }
        const session = sessions[nextIndex++]
        this.pendingSessions = [session, ...sessions.slice(nextIndex)]
        this.activeCwd = session.cwd ?? process.cwd()
        this.indexStatus = {
          ...this.indexStatus,
          activeSession: {
            agent: session.agent,
            sessionId: session.sessionId,
            title: session.title
          }
        }
        try {
          await generateConversationKnowledgeFromSession({
            ...this.dependencies,
            session,
            args: {
              sourceAgent: session.agent,
              sessionId: session.sessionId,
              generatorAgent: args.generatorAgent,
              generatorModel: args.generatorModel,
              language: args.language
            }
          })
          if (!this.cancelRequested) {
            this.indexStatus = {
              ...this.indexStatus,
              completed: this.indexStatus.completed + 1
            }
          }
        } catch (error) {
          if (!this.cancelRequested && !isCanceledConversationKnowledgeGeneration(error)) {
            this.indexStatus = { ...this.indexStatus, failed: this.indexStatus.failed + 1 }
          }
        } finally {
          this.activeCwd = null
          if (this.indexStatus.activeSession?.sessionId === session.sessionId) {
            delete this.indexStatus.activeSession
          }
          this.pendingSessions = sessions.slice(nextIndex)
          this.writeCheckpoint(this.cancelRequested ? 'stopped' : 'running', args)
        }
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(MAX_CONCURRENT_SUMMARIES, sessions.length) }, () => worker())
    )
  }
  private async restoreInterruptedIndex(): Promise<void> {
    const recovered = await readResumableConversationKnowledgeIndex(this.dependencies)
    if (!recovered) {
      return
    }
    const { checkpoint, sessions } = recovered
    this.indexStatus = {
      state: 'running',
      total: checkpoint.total,
      completed: checkpoint.completed,
      failed: checkpoint.failed
    }
    this.indexConfig = JSON.stringify({
      generatorAgent: checkpoint.config.generatorAgent,
      generatorModel: resolveConversationKnowledgeModel(
        checkpoint.config.generatorAgent,
        checkpoint.config.generatorModel
      ),
      scopePaths: checkpoint.config.scopePaths ?? [],
      language: checkpoint.config.language ?? 'en'
    })
    this.pendingSessions = sessions
    this.indexPromise = this.runIndex(sessions, checkpoint.config).finally(() => {
      this.indexStatus = { ...this.indexStatus, state: 'idle' }
      this.pendingSessions = []
      this.writeCheckpoint('stopped', checkpoint.config)
      this.indexPromise = null
      this.indexConfig = null
    })
  }
  private writeCheckpoint(
    state: ConversationKnowledgeIndexCheckpoint['state'],
    args?: {
      generatorAgent: TuiAgent
      generatorModel: string
      scopePaths?: string[]
      language?: string
    }
  ): void {
    const config = args ?? (this.indexConfig ? JSON.parse(this.indexConfig) : null)
    writeConversationKnowledgeIndexCheckpoint({
      store: this.dependencies.checkpointStore,
      state,
      config,
      status: this.indexStatus,
      sessions: this.pendingSessions
    })
  }
  async list(scopePaths?: readonly string[]): Promise<ConversationKnowledgeItem[]> {
    return listConversationKnowledge({ ...this.dependencies, scopePaths })
  }
}
