import { app, ipcMain } from 'electron'
import { readAiVaultHistorySession, searchAiVaultHistory } from '../ai-vault/session-history'
import { AI_VAULT_AGENTS, type AiVaultAgent } from '../../shared/ai-vault-types'
import { getConversationKnowledgeService } from '../ai-vault/conversation-knowledge-service-registry'
import { getCommitMessageAgentSpec } from '../../shared/commit-message-agent-spec'
import { searchConversationKnowledgeItems } from '../../shared/conversation-knowledge-items'
import type { TuiAgent } from '../../shared/tui-agent'
import { ALL_TUI_AGENTS } from '../../shared/tui-agent-display-names'
import type { CommitMessageAgentEnvironmentResolvers } from '../text-generation/commit-message-agent-environment'

export function registerAiVaultHistoryHandlers(
  environmentResolvers?: CommitMessageAgentEnvironmentResolvers
): void {
  const knowledgeService = () =>
    getConversationKnowledgeService({
      userDataPath: app.getPath('userData'),
      getEnvironmentResolvers: () => environmentResolvers
    })
  ipcMain.handle('aiVault:searchHistory', (_event, args: { query?: unknown; limit?: unknown }) =>
    searchAiVaultHistory({
      query: typeof args?.query === 'string' ? args.query.slice(0, 512) : '',
      limit: typeof args?.limit === 'number' ? args.limit : undefined
    })
  )
  ipcMain.handle(
    'aiVault:readHistory',
    (_event, args: { agent?: unknown; sessionId?: unknown; limit?: unknown }) =>
      readAiVaultHistorySession({
        agent: isAiVaultAgent(args?.agent) ? args.agent : 'codex',
        sessionId: typeof args?.sessionId === 'string' ? args.sessionId : '',
        limit: typeof args?.limit === 'number' ? args.limit : undefined
      })
  )
  ipcMain.handle(
    'aiVault:enrichHistory',
    async (
      _event,
      args: {
        sourceAgent?: unknown
        sessionId?: unknown
        generatorAgent?: unknown
        generatorModel?: unknown
        language?: unknown
      }
    ) => {
      if (!isAiVaultAgent(args?.sourceAgent) || !isGenerationAgent(args?.generatorAgent)) {
        throw new Error('A valid source and summary agent are required.')
      }
      return knowledgeService().generate({
        sourceAgent: args.sourceAgent,
        sessionId: typeof args?.sessionId === 'string' ? args.sessionId : '',
        generatorAgent: args.generatorAgent,
        generatorModel: typeof args?.generatorModel === 'string' ? args.generatorModel : null,
        language: typeof args?.language === 'string' ? args.language.slice(0, 32) : undefined
      })
    }
  )
  ipcMain.handle(
    'aiVault:listKnowledge',
    async (_event, args: { query?: unknown; scopePaths?: unknown }) => {
      const scopePaths = Array.isArray(args?.scopePaths)
        ? args.scopePaths.filter((path): path is string => typeof path === 'string').slice(0, 64)
        : undefined
      const items = await knowledgeService().list(scopePaths)
      const query = typeof args?.query === 'string' ? args.query.slice(0, 512) : ''
      return { items: searchConversationKnowledgeItems(items, query) }
    }
  )
  ipcMain.handle(
    'aiVault:startKnowledgeIndex',
    async (
      _event,
      args: {
        generatorAgent?: unknown
        generatorModel?: unknown
        scopePaths?: unknown
        force?: unknown
        language?: unknown
      }
    ) => {
      if (!isGenerationAgent(args?.generatorAgent) || typeof args?.generatorModel !== 'string') {
        throw new Error('A valid summary agent and model are required.')
      }
      return knowledgeService().startIndex({
        generatorAgent: args.generatorAgent,
        generatorModel: args.generatorModel,
        scopePaths: Array.isArray(args.scopePaths)
          ? args.scopePaths.filter((path): path is string => typeof path === 'string').slice(0, 64)
          : undefined,
        force: args.force === true,
        language: typeof args.language === 'string' ? args.language.slice(0, 32) : undefined
      })
    }
  )
  ipcMain.handle('aiVault:getKnowledgeIndexStatus', () => knowledgeService().getIndexStatus())
  ipcMain.handle('aiVault:cancelKnowledgeIndex', () => knowledgeService().cancelIndex())
}

function isAiVaultAgent(value: unknown): value is AiVaultAgent {
  return typeof value === 'string' && AI_VAULT_AGENTS.some((agent) => agent === value)
}

function isGenerationAgent(value: unknown): value is TuiAgent {
  return (
    typeof value === 'string' &&
    ALL_TUI_AGENTS.some(
      (agent) => agent === value && getCommitMessageAgentSpec(agent) !== undefined
    )
  )
}
