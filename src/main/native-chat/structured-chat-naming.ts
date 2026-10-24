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
  | { error: string; failureOutput?: AgentGenerationFailureOutput }
  | null

export type StructuredChatNamingDeps = {
  getStore: () => Pick<
    AgentSessionRecordStore,
    'getRecord' | 'compareAndSetConversationName'
  > | null
  getSettings: () => Pick<GlobalSettings, 'nativeChatAutoName'>
  readFirstPrompt: (sessionId: string, hostStartedAt: number) => Promise<string>
  /** Explicit regeneration may use prompts predating host startup. */
  readJournalFirstPrompt: (sessionId: string) => Promise<string>
  now?: () => number
  workerTaskTitle: (record: AgentSessionRecord) => { title: string } | null
  generate: (
    record: AgentSessionRecord,
    firstPrompt: string
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
  const attempted = new Set<string>()
  // Serialize initial naming and explicit regeneration per chat.
  const jobs = new Map<string, Promise<void>>()
  const failures = new Map<string, StructuredChatNamingFailure>()
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
  const run = (sessionId: string, workspaceId: string, job: () => Promise<void>) => {
    if (!jobs.has(sessionId)) {
      const running = Promise.resolve()
        .then(job)
        .catch((error: unknown) => warn(sessionId, error))
        .finally(() => {
          jobs.delete(sessionId)
          refresh(workspaceId, sessionId)
        })
      jobs.set(sessionId, running)
      refresh(workspaceId, sessionId)
    }
  }
  // Repeated failures need distinct identities even when their short messages match.
  const failedAt = (sessionId: string) =>
    Math.max(now(), (failures.get(sessionId)?.failedAt ?? 0) + 1)
  const forget = (sessionId: string) => {
    failures.delete(sessionId)
    failureOutputs.delete(sessionId)
  }
  const fail = (record: AgentSessionRecord, forName: string, failure: NamingRunFailure) => {
    const message = sliceAtCodeUnitLimit(failure.error, NAMING_ERROR_LIMIT)
    failures.set(record.sessionId, { message, failedAt: failedAt(record.sessionId), forName })
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
    for (let attempt = 0; ; attempt += 1) {
      let failure: NamingRunFailure
      try {
        const result = await deps.generate(record, firstPrompt)
        if (!result) {
          return null
        }
        if ('name' in result && result.name) {
          return result.name
        }
        failure = 'error' in result ? result : { error: 'The chat-name agent returned no name.' }
      } catch (error) {
        warn(record.sessionId, error)
        failure = { error: 'Orca could not run the chat-name agent.' }
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
  }

  async function setName(store: NamingStore, record: AgentSessionRecord, name: string) {
    const expected = record.conversationName ?? null
    const named =
      name === expected
        ? record
        : await store.compareAndSetConversationName(record.sessionId, name, expected)
    if (named) {
      forget(record.sessionId)
      refresh(named.location.workspaceId, named.sessionId)
    }
  }

  async function name(summary: AgentSessionStatusSummary) {
    const store = deps.getStore()
    const record = store?.getRecord(summary.sessionId)
    const namingOff = () => deps.getSettings().nativeChatAutoName === false
    if (!store || !record || record.conversationName !== undefined || namingOff()) {
      return
    }
    const workerTask = deps.workerTaskTitle(record)
    if (workerTask) {
      const named =
        workerTask.title &&
        (await store.compareAndSetConversationName(summary.sessionId, workerTask.title, null))
      if (named) {
        refresh(named.location.workspaceId, named.sessionId)
      }
      return
    }
    const firstPrompt = clampConversationNameFirstPrompt(
      await deps.readFirstPrompt(record.sessionId, hostStartedAt)
    )
    const seed = hasStructuredChatPromptText(firstPrompt) ? conversationNameSeed(firstPrompt) : null
    if (!seed || namingOff()) {
      return
    }
    // Seed immediately so failed generation still leaves a usable name.
    const seeded = await store.compareAndSetConversationName(summary.sessionId, seed, null)
    if (!seeded?.conversationName) {
      return
    }
    refresh(seeded.location.workspaceId, seeded.sessionId)
    const seedName = seeded.conversationName
    const stillSeeded = () =>
      !namingOff() && store.getRecord(seeded.sessionId)?.conversationName === seedName
    const chatName = await generateName(
      seeded,
      firstPrompt,
      seedName,
      GENERATION_RETRY_DELAYS_MS,
      stillSeeded
    )
    if (chatName && !namingOff()) {
      await setName(store, seeded, chatName)
    }
  }

  async function rename(store: NamingStore, record: AgentSessionRecord) {
    const current = record.conversationName ?? ''
    const stillCurrent = () =>
      (store.getRecord(record.sessionId)?.conversationName ?? '') === current
    const firstPrompt = clampConversationNameFirstPrompt(
      await deps.readJournalFirstPrompt(record.sessionId)
    )
    const chatName = hasStructuredChatPromptText(firstPrompt)
      ? await generateName(record, firstPrompt, current, [], stillCurrent)
      : null
    if (chatName) {
      await setName(store, record, chatName)
    }
  }

  const observe = (
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
    run(summary.sessionId, summary.workspaceId, () => name(summary))
  }

  const naming: StructuredAgentSessionConversationNaming = {
    activeSessionIds: () => [...jobs.keys()],
    failure: (sessionId) => failures.get(sessionId),
    failureOutput: (sessionId) => {
      const output = failureOutputs.get(sessionId)
      return output ? formatAgentGenerationFailureOutputForDisplay(output) : null
    },
    regenerate: (sessionId) => {
      const store = deps.getStore()
      const record = store?.getRecord(sessionId)
      if (!store || !record) {
        return false
      }
      // Prevent deferred first naming from overwriting explicit regeneration.
      attempted.add(sessionId)
      run(sessionId, record.location.workspaceId, () => rename(store, record))
      return true
    }
  }
  return Object.assign(observe, naming)
}
