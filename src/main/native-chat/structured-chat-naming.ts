import { chatNamingFailure } from '../../shared/chat-naming-failure-copy'
import { createStructuredChatNamingWork, type NamingRequest } from './structured-chat-naming-work'
import type { StructuredAgentSessionStatusObserverOptions } from './agent-session-wire/structured-agent-session-status-observation'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import type { AgentSessionStatusSummary } from '../../shared/agent-session-wire'
import {
  clampConversationNameFirstPrompt,
  conversationNameSeed
} from '../../shared/conversation-name-generation'
import { hasStructuredChatPromptText } from '../../shared/structured-agent-session-first-prompt'
import { sliceAtCodeUnitLimit } from '../../shared/surrogate-safe-text-slice'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { AgentSessionRecordStore } from '../runtime/agent-session-record-store'
import {
  formatAgentGenerationFailureOutputForDisplay,
  type AgentGenerationFailureOutput
} from '../text-generation/agent-failure-output'
import type {
  StructuredAgentSessionConversationNaming,
  StructuredChatNamingFailure
} from './agent-session-wire/structured-agent-session-host-types'
import {
  neverThrowingStructuredAgentSessionLogger,
  type StructuredAgentSessionLogger
} from './agent-session-wire/structured-agent-session-logger'

/** null means unavailable/canceled: no failure to display or retry. */
export type StructuredChatNameGeneration =
  | { name: string }
  | { error: string; errorCode?: string; failureOutput?: AgentGenerationFailureOutput }
  | null

export type StructuredChatNamingDeps = {
  getStore: () => Pick<
    AgentSessionRecordStore,
    'getRecord' | 'compareAndSetConversationName' | 'setUserConversationName'
  > | null
  getSettings: () => Pick<GlobalSettings, 'nativeChatAutoName'>
  readFirstPrompt: (sessionId: string, hostStartedAt: number) => Promise<string>
  /** The current context's first prompt, for a name the user asked for again. */
  readJournalFirstPrompt: (sessionId: string) => Promise<string>
  now?: () => number
  workerTaskTitle: (record: AgentSessionRecord) => { title: string } | null
  generate: (
    record: AgentSessionRecord,
    firstPrompt: string,
    shouldExecute?: () => boolean
  ) => Promise<StructuredChatNameGeneration>
  onNamed: (workspaceId: string, sessionId: string) => void
  logger: StructuredAgentSessionLogger
  wait?: (ms: number) => Promise<void>
}

const GENERATION_RETRY_DELAYS_MS = [2000, 4000]
const NAMING_ERROR_LIMIT = 1024
const FAILURE_OUTPUT_ENTRIES = 32

const waitFor = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

type NamingStore = NonNullable<ReturnType<StructuredChatNamingDeps['getStore']>>
type NamingRunFailure = Exclude<StructuredChatNameGeneration, null | { name: string }>

export function createStructuredChatNamingHandler(deps: StructuredChatNamingDeps) {
  const contextId = (chat: AgentSessionRecord) => chat.providerContextBoundary?.operationId ?? null
  const attempted = new Map<string, string | null>()
  const failures = new Map<
    string,
    { context: string | null; failure: StructuredChatNamingFailure }
  >()
  // Retain diagnostics locally without publishing or persisting them.
  const failureOutputs = new Map<string, AgentGenerationFailureOutput>()
  const now = deps.now ?? Date.now
  const hostStartedAt = now()
  const logger = neverThrowingStructuredAgentSessionLogger(deps.logger)
  const warn = (sessionId: string, error: unknown) =>
    logger.warn('Chat name generation failed', {
      scope: 'conversation-name',
      sessionId,
      error
    })
  const refresh = (workspaceId: string, sessionId: string) => {
    try {
      deps.onNamed(workspaceId, sessionId)
    } catch (error) {
      warn(sessionId, error)
    }
  }
  const currentContext = (sessionId: string, context: string | null) => {
    const record = deps.getStore()?.getRecord(sessionId)
    return !!record && contextId(record) === context
  }
  const applicable = (request: NamingRequest) => {
    const store = deps.getStore()
    return (
      !!store &&
      generationStillCurrent(store, request.record) &&
      (!request.automatic || deps.getSettings().nativeChatAutoName !== false)
    )
  }
  const work = createStructuredChatNamingWork({
    applicable,
    prepare,
    execute: async (request, firstPrompt) => {
      if (!applicable(request)) {
        return
      }
      const name = await generateName(
        request.record,
        firstPrompt,
        request.record.conversationName ?? '',
        request.automatic ? GENERATION_RETRY_DELAYS_MS : [],
        () => applicable(request)
      )
      const store = deps.getStore()
      if (name && store && applicable(request)) {
        await setName(store, request.record, name)
      }
    },
    changed: (record) => refresh(record.location.workspaceId, record.sessionId),
    warn
  })
  const failure = (sessionId: string) => {
    const entry = failures.get(sessionId)
    return entry && currentContext(sessionId, entry.context) ? entry.failure : undefined
  }
  const forget = (sessionId: string) => {
    failures.delete(sessionId)
    failureOutputs.delete(sessionId)
  }
  const fail = (record: AgentSessionRecord, forName: string, failure: NamingRunFailure) => {
    const message = sliceAtCodeUnitLimit(failure.error, NAMING_ERROR_LIMIT)
    // Distinguish actual failures even when their short messages are identical.
    const failedAt = Math.max(now(), (failures.get(record.sessionId)?.failure.failedAt ?? 0) + 1)
    failures.set(record.sessionId, {
      context: contextId(record),
      failure: { message, failedAt, forName, messageCode: failure.errorCode }
    })
    failureOutputs.delete(record.sessionId)
    if (failure.failureOutput) {
      failureOutputs.set(record.sessionId, failure.failureOutput)
      for (const oldest of failureOutputs.keys()) {
        if (failureOutputs.size <= FAILURE_OUTPUT_ENTRIES) {
          break
        }
        failureOutputs.delete(oldest)
      }
    }
    refresh(record.location.workspaceId, record.sessionId)
  }

  async function generateName(
    record: AgentSessionRecord,
    firstPrompt: string,
    forName: string,
    retryDelays: readonly number[],
    stillCurrent: () => boolean
  ): Promise<string | null> {
    attempted.set(record.sessionId, contextId(record))
    for (let attempt = 0; stillCurrent(); attempt += 1) {
      let failure: NamingRunFailure
      try {
        const result = await deps.generate(record, firstPrompt, stillCurrent)
        if (!result) {
          return null
        }
        if ('name' in result && result.name) {
          return result.name
        }
        failure = 'error' in result ? result : chatNamingFailure('noName')
      } catch (error) {
        warn(record.sessionId, error)
        failure = chatNamingFailure('agentNotRun')
      }
      if (!stillCurrent()) {
        return null
      }
      const delay = retryDelays[attempt]
      if (delay === undefined) {
        if (stillCurrent()) {
          fail(record, forName, failure)
        }
        return null
      }
      await (deps.wait ?? waitFor)(delay)
      if (!stillCurrent()) {
        return null
      }
    }
    return null
  }

  async function setName(store: NamingStore, record: AgentSessionRecord, name: string) {
    const expected = record.conversationName ?? null
    const named = await store.compareAndSetConversationName(
      record.sessionId,
      name,
      expected,
      contextId(record)
    )
    if (named) {
      forget(record.sessionId)
      refresh(named.location.workspaceId, named.sessionId)
    }
  }

  const generationStillCurrent = (store: NamingStore, record: AgentSessionRecord) => {
    const current = store.getRecord(record.sessionId)
    return (
      current !== null &&
      current.conversationNameSource !== 'user' &&
      current.conversationName === record.conversationName &&
      contextId(current) === contextId(record)
    )
  }

  async function prepare(request: NamingRequest): Promise<NamingRequest | null> {
    const store = deps.getStore()
    if (!store || !applicable(request)) {
      return null
    }
    const { record, automatic } = request
    if (automatic && record.conversationName !== undefined) {
      return null
    }
    const workerTask =
      automatic && !record.providerContextBoundary ? deps.workerTaskTitle(record) : null
    if (workerTask) {
      if (workerTask.title) {
        await setName(store, record, workerTask.title)
      }
      return null
    }
    const firstPrompt = clampConversationNameFirstPrompt(
      await (automatic
        ? deps.readFirstPrompt(record.sessionId, hostStartedAt)
        : deps.readJournalFirstPrompt(record.sessionId))
    )
    if (!hasStructuredChatPromptText(firstPrompt) || !applicable(request)) {
      return null
    }
    if (!automatic) {
      return { ...request, firstPrompt }
    }
    // Seeding is independent of the expensive execution owner.
    const seeded = await store.compareAndSetConversationName(
      record.sessionId,
      conversationNameSeed(firstPrompt),
      null,
      contextId(record)
    )
    if (!seeded?.conversationName) {
      return null
    }
    request.record = seeded
    request.firstPrompt = firstPrompt
    refresh(seeded.location.workspaceId, seeded.sessionId)
    return request
  }

  const observe = (
    summary: AgentSessionStatusSummary,
    options: StructuredAgentSessionStatusObserverOptions
  ): void => {
    if (
      options.replay ||
      options.firstInputSubmissionKey === null ||
      summary.status !== 'working'
    ) {
      return
    }
    try {
      const store = deps.getStore()
      const record = store?.getRecord(summary.sessionId)
      if (!store || !record || attempted.get(summary.sessionId) === contextId(record)) {
        return
      }
      attempted.set(summary.sessionId, contextId(record))
      work.run(record, true)
    } catch (error) {
      warn(summary.sessionId, error)
    }
  }

  const naming: StructuredAgentSessionConversationNaming = {
    publishName: refresh,
    activeSessionIds: work.activeSessionIds,
    failure,
    failureOutput: (sessionId) => {
      const output = failure(sessionId) ? failureOutputs.get(sessionId) : undefined
      return output ? formatAgentGenerationFailureOutputForDisplay(output) : null
    },
    regenerate: (sessionId) => {
      const store = deps.getStore()
      const record = store?.getRecord(sessionId)
      if (!store || !record) {
        return false
      }
      work.run(record, false)
      return true
    },
    // Not a job: a pending generation must not swallow the user's rename. The record's 'user'
    // source is what makes that generation's later write refuse.
    setUserName: async (sessionId, name, write) => {
      const store = deps.getStore()
      if (!store?.getRecord(sessionId)) {
        return null
      }
      const { record, applied } = await store.setUserConversationName(sessionId, name, write)
      if (applied) {
        forget(sessionId)
      }
      refresh(record.location.workspaceId, sessionId)
      return { name: record.conversationName ?? null, applied }
    }
  }
  return Object.assign(observe, naming)
}
