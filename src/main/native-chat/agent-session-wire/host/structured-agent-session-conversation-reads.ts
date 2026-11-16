import { holdStructuredMailSources } from '../observations/structured-agent-session-mail-sources'
import {
  createStructuredAgentSessionCatalogReads,
  structuredAgentSessionCatalogScopeOwned
} from '../options/structured-agent-session-catalog-reads'
import { revealStructuredAgentSession } from './structured-agent-session-reveal'
import { hostStructuredAgentSessionCurrentWork } from '../observations/structured-agent-session-host-current-work'
import type { StructuredAgentSessionClientDelivery } from '../publication/subscribers/structured-agent-session-client-delivery'
import type { AgentSessionExecutionLocation } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import type { StructuredAttentionRead } from '../../../../shared/agent-session/agent-session-attention'
import * as providerSupport from '../providers/structured-agent-session-provider-support'
import type {
  SetUserConversationName,
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'
import {
  queuedSendAnswer,
  structuredSendAnswer
} from '../delivery/structured-agent-session-queued-send-answer'
import type { JournalMailAttempt } from '../../agent-session-journal/journal-mail-observation'
import { captureHostStructuredAgentSessionWork } from '../observations/structured-agent-session-read-work'
import { copyJournalCurrentWorkAuthority } from '../../agent-session-journal/journal-observer-read'
import type { AgentSessionFailureResumeResult } from '../../../../shared/agent-session/agent-session-held-delivery'
import type { JournalFailureAuthority } from '../../agent-session-journal/journal-failure-authority'

type ReadContext = {
  deps: StructuredAgentSessionHostDeps
  sessions: Map<string, StructuredAgentSessionHostSession>
  serialize: <T>(id: string, task: () => Promise<T>) => Promise<T>
  seal: (id: string) => void
  onFailureResumed: (sessionId: string) => void
  readCommands: StructuredAgentSessionClientDelivery['readCommandsSettled']
  conversation: (id: string) => Promise<StructuredAgentSessionHostSession>
}

/** Readers share the conversation owner; inventory never founds a journal or prepares a provider. */
export function createStructuredAgentSessionConversationReads(context: () => ReadContext) {
  const setUserConversationName: SetUserConversationName = (...args) =>
    context().deps.conversationNaming?.setUserName(...args) ?? Promise.resolve(null)
  const readModelCatalog = createStructuredAgentSessionCatalogReads(() => ({
    deps: context().deps,
    serialize: context().serialize,
    scopeOwned: async (params) => {
      const record = params.sessionId
        ? context().deps.store.getConversation(params.sessionId)
        : undefined
      if (
        record &&
        (record.provider !== params.agent ||
          !providerSupport.agentDrivesSession(context().deps.agents, record))
      ) {
        return null
      }
      if (!record) {
        return null
      }
      if (!context().deps.store.getRecord(record.sessionId)) {
        return structuredAgentSessionCatalogScopeOwned(context().deps, params, undefined)
      }
      return structuredAgentSessionCatalogScopeOwned(
        context().deps,
        params,
        context().sessions.get(record.sessionId)
      )
    }
  }))
  const journalOf = async (id: string) => (await context().conversation(id)).journal
  return {
    heldDelivery: async (id: string) => (await journalOf(id)).queuedMessages.heldDelivery(),
    resumeFailure: (
      id: string,
      request: {
        expectedFailureId: string
        operationId: string
        coordinatorId: string
        dispatchId: string
        expectedRuntimeFence: number
        hasMessage?: true
        authorization: JournalFailureAuthority
      },
      authorize: () => void
    ): Promise<AgentSessionFailureResumeResult> =>
      context().serialize(id, async () => {
        authorize()
        const journal = await journalOf(id)
        const { expectedRuntimeFence, ...intent } = request
        const commit = await journal.write(
          { kind: 'failure-resume', fence: expectedRuntimeFence, ...intent },
          () => {
            authorize()
            const { deps, sessions } = context()
            return {
              facts: {
                send: copyJournalCurrentWorkAuthority(
                  captureHostStructuredAgentSessionWork(
                    { store: deps.store, sessions },
                    id,
                    journal
                  )
                )
              }
            }
          }
        )
        const value = commit.value
        if (
          !value ||
          typeof value !== 'object' ||
          !('status' in value) ||
          !('waiting' in value) ||
          typeof value.waiting !== 'number'
        ) {
          throw new Error('Invalid failure recovery result')
        }
        const remaining = {
          waiting: value.waiting,
          ...('stillHeld' in value && typeof value.stillHeld === 'number'
            ? { stillHeld: value.stillHeld }
            : {}),
          ...('heldReason' in value && typeof value.heldReason === 'string'
            ? { heldReason: value.heldReason }
            : {})
        }
        switch (value.status) {
          case 'resumed':
            context().onFailureResumed(id)
            return { status: value.status, ...remaining }
          case 'not-failed':
          case 'stale-failure':
          case 'already-used':
          case 'blocked':
          case 'not-retryable':
          case 'message-attached':
            return { status: value.status, ...remaining }
          default:
            throw new Error('Invalid failure recovery status')
        }
      }),
    currentWorkAtRest: async (sessionId: string) => {
      await context().conversation(sessionId)
      const { deps, sessions } = context()
      return hostStructuredAgentSessionCurrentWork({ store: deps.store, sessions }, sessionId)
    },
    namingPrompt: async (sessionId: string, hostStartedAt?: number) =>
      (await journalOf(sessionId)).reads.namingPrompt(hostStartedAt),
    approvalPrompt: async (sessionId: string, itemId: string) =>
      (await journalOf(sessionId)).reads.item(itemId),
    automationRun: async (sessionId: string, messageId: string, inputIds: readonly string[]) =>
      (await journalOf(sessionId)).reads.automationRun(messageId, inputIds),

    readModelCatalog,
    attentionReads: {
      workspace: async (
        location: AgentSessionExecutionLocation
      ): Promise<(StructuredAttentionRead & { scope: AgentSessionExecutionLocation })[]> => {
        const { deps, sessions } = context()
        const reads = await Promise.all(
          (await deps.store.workspaceAttentionReads(location)).map(async (read) => {
            const journal = sessions.get(read.sessionId)?.journal
            try {
              return journal
                ? { ...read, observedCursor: await journal.readInOrder(journal.reads.cursor) }
                : read
            } catch (error) {
              deps.logger.warn('capturing a workspace attention boundary failed', {
                scope: 'workspace-attention-read',
                sessionId: read.sessionId,
                error
              })
              return null
            }
          })
        )
        return reads.flatMap((read) => (read ? [read] : []))
      },
      sessionLocation: (id: string): AgentSessionExecutionLocation | null =>
        context().deps.store.getConversation(id)?.location ?? null
    },
    regenerateConversationName: (sessionId: string): boolean =>
      context().deps.conversationNaming?.regenerate(sessionId) ?? false,
    setUserConversationName,
    holdMailSources: (attempts: readonly JournalMailAttempt[], signal: AbortSignal) => {
      const { serialize, sessions, deps, conversation, seal } = context()
      return holdStructuredMailSources(
        { serialize, sessions, store: deps.store, conversation, seal },
        attempts,
        signal
      )
    },
    queuedSendAnswer: async (id: string, messageId: string) =>
      queuedSendAnswer(await journalOf(id), messageId),
    mailObservation: async (attempt: JournalMailAttempt) =>
      (await journalOf(attempt.session_id)).reads.mailObservation(attempt),
    sendAnswer: async (id: string, messageId: string) =>
      structuredSendAnswer(
        await journalOf(id),
        (operationId) => context().deps.store.readCommandReceipt({ kind: 'global' }, operationId),
        id,
        messageId
      ),
    readCommands: (id: string, commandsOnRequest = false) =>
      context().readCommands(id, commandsOnRequest),
    supportsCreate: (location: AgentSessionExecutionLocation, agent: string) =>
      providerSupport.adapterSupportsCreate(context().deps.adapter, location, agent),
    knownAgentIds: () => providerSupport.knownAgentIds(context().deps),
    agentDefinitions: () => context().deps.agents.definitions(),
    revealSession: (id: string) => {
      const { deps, conversation } = context()
      return revealStructuredAgentSession(deps, id, conversation)
    },
    sessionAgent: (id: string) => context().deps.store.getConversation(id)?.provider ?? null,
    childAccountHome: (id: string) => context().sessions.get(id)?.child?.accountHome,
    holdsSessions: () => context().deps.store.holdsRecords(),
    onSessionsHeld: (listener: () => void) => context().deps.store.onFirstRecord(listener),
    prospectiveAccountHome: (id: string) => {
      const { deps, serialize } = context()
      return serialize(
        id,
        async () => (await deps.launchAccountHome?.(deps.store.requireWritableRecord(id))) ?? null
      )
    }
  }
}
