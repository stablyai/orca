import type { StructuredAgentSessionStatusObserverOptions } from './agent-session-wire/structured-agent-session-status-observation'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import type { AgentSessionStatusSummary } from '../../shared/agent-session-wire'
import { clampConversationNameFirstPrompt } from '../../shared/conversation-name-generation'
import { hasStructuredChatPromptText } from '../../shared/structured-agent-session-first-prompt'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { AgentSessionRecordStore } from '../runtime/agent-session-record-store'
import {
  neverThrowingStructuredAgentSessionLogger,
  type StructuredAgentSessionLogger
} from './agent-session-wire/structured-agent-session-logger'

export type StructuredChatNamingDeps = {
  getStore: () => Pick<
    AgentSessionRecordStore,
    'getRecord' | 'compareAndSetConversationName'
  > | null
  getSettings: () => Pick<GlobalSettings, 'nativeChatAutoName'>
  readFirstPrompt: (sessionId: string, hostStartedAt: number) => Promise<string>
  now?: () => number
  hasOpenDispatch: (record: AgentSessionRecord) => boolean
  generate: (record: AgentSessionRecord, firstPrompt: string) => Promise<string | null>
  onNamed: (workspaceId: string, sessionId: string) => void
  logger: StructuredAgentSessionLogger
}

export function createStructuredChatNamingHandler(deps: StructuredChatNamingDeps) {
  const attempted = new Set<string>()
  const hostStartedAt = (deps.now ?? Date.now)()
  const logger = neverThrowingStructuredAgentSessionLogger(deps.logger)
  const warn = (sessionId: string, error: unknown) =>
    logger.warn('Chat name generation failed', {
      scope: 'conversation-name',
      sessionId,
      error
    })
  const refresh = (record: AgentSessionRecord) => {
    try {
      deps.onNamed(record.location.workspaceId, record.sessionId)
    } catch (error) {
      warn(record.sessionId, error)
    }
  }

  async function name(summary: AgentSessionStatusSummary) {
    const store = deps.getStore()
    const record = store?.getRecord(summary.sessionId)
    if (
      !store ||
      !record ||
      record.conversationName !== undefined ||
      deps.hasOpenDispatch(record)
    ) {
      return
    }
    const firstPrompt = clampConversationNameFirstPrompt(
      await deps.readFirstPrompt(summary.sessionId, hostStartedAt)
    )
    if (
      !hasStructuredChatPromptText(firstPrompt) ||
      store.getRecord(summary.sessionId)?.conversationName !== undefined ||
      deps.getSettings().nativeChatAutoName === false
    ) {
      return
    }
    const generated = await deps.generate(record, firstPrompt)
    if (!generated) {
      return
    }
    const named = await store.compareAndSetConversationName(summary.sessionId, generated, null)
    if (named) {
      refresh(named)
    }
  }

  return (
    summary: AgentSessionStatusSummary,
    options: StructuredAgentSessionStatusObserverOptions
  ): void => {
    if (
      options.replay ||
      options.firstInputSubmissionKey === null ||
      summary.status !== 'working' ||
      attempted.has(summary.sessionId)
    ) {
      return
    }
    attempted.add(summary.sessionId)
    void name(summary).catch((error: unknown) => warn(summary.sessionId, error))
  }
}
