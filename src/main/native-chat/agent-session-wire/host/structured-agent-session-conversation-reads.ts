import { agentSessionLeaseOwnerVerdict } from '../../../../shared/agent-session/lifecycle/leases/agent-session-lease-adjudication'
import { holdStructuredMailSources } from '../observations/structured-agent-session-mail-sources'
import {
  createStructuredAgentSessionCatalogReads,
  structuredAgentSessionCatalogScopeOwned
} from '../options/structured-agent-session-catalog-reads'
import { revealStructuredAgentSession } from './structured-agent-session-reveal'
import { hostStructuredAgentSessionCurrentWork } from '../observations/structured-agent-session-host-current-work'
import type { StructuredAgentSessionClientDelivery } from '../publication/subscribers/structured-agent-session-client-delivery'
import type { AgentSessionExecutionLocation } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import type { StructuredAttentionRead } from '../../../../shared/agent-session/view/agent-session-attention'
import * as providerSupport from '../providers/structured-agent-session-provider-support'
import type {
  SetUserConversationName,
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'
import {
  readAgentJournalPage,
  type AgentReadJournalPage
} from '../publication/history/agent-read-journal-page'
import {
  queuedSendAnswer,
  structuredSendAnswer
} from '../delivery/structured-agent-session-queued-send-answer'
import type { StructuredAgentSessionHostRuntimeState } from './structured-agent-session-host-runtime-state'
import type { JournalMailAttempt } from '../../agent-session-journal/journal-mail-observation'
import { compareAgentJournalItems } from '../../../../shared/agent-session/journal/agent-session-journal-position'

type ReadContext = {
  deps: StructuredAgentSessionHostDeps
  sessions: Map<string, StructuredAgentSessionHostSession>
  serialize: <T>(id: string, task: () => Promise<T>) => Promise<T>
  seal: (id: string) => void
  client: Pick<StructuredAgentSessionClientDelivery, 'readCommandsSettled' | 'subscribers'>
  conversation: (id: string) => Promise<StructuredAgentSessionHostSession>
  publishStatus: (id: string) => void
  runtimeState: Pick<StructuredAgentSessionHostRuntimeState, 'startFlights'>
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
    /** Opened at rest; pending prompts wait only while the conversation can answer them. */
    agentReadPage: async (sessionId: string, limit: number): Promise<AgentReadJournalPage> => {
      const journal = await journalOf(sessionId)
      const { deps, sessions } = context()
      const work = await hostStructuredAgentSessionCurrentWork(
        { store: deps.store, sessions },
        sessionId
      )
      const actionable = work ? new Set(work.actionablePromptIds()) : null
      const page = await readAgentJournalPage(
        journal,
        { sessionId, limit },
        (itemId) => actionable?.has(itemId) ?? true
      )
      const record = deps.store.getRecord(sessionId)
      const session = sessions.get(sessionId)
      // A dead owner cannot be working; a completion the snapshot proved stays proved.
      if (
        page.state === 'working' &&
        record &&
        (agentSessionLeaseOwnerVerdict(record.lease) === 'exited' ||
          (!session?.child && session?.lastEndedChild?.rootGone))
      ) {
        const { state: _state, ...content } = page
        return content
      }
      return page
    },

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
    /** Skip on an async question card: saved on the chat, so every device and the status agree.
     *  Only moves forward: a device that has not loaded the newest question cannot bring it back. */
    skipAsyncQuestions: async (sessionId: string, itemId: string) => {
      // Opening serializes on this chat too, so it runs before the write takes the slot.
      await context().conversation(sessionId)
      return context().serialize(sessionId, async () => {
        const { deps, sessions, publishStatus } = context()
        const reads = sessions.get(sessionId)?.journal.reads
        if (!reads) {
          return
        }
        const saved = deps.store.getRecord(sessionId)?.asyncQuestionsSkippedThrough
        const [previous, next] = await Promise.all([
          saved === undefined ? undefined : reads.item(saved),
          reads.item(itemId)
        ])
        if (!next || (previous && compareAgentJournalItems(previous, next) >= 0)) {
          return
        }
        await deps.store.skipAsyncQuestions(sessionId, itemId)
        publishStatus(sessionId)
      })
    },
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
      context().client.readCommandsSettled(id, commandsOnRequest),
    /** Some client has the chat open on a screen now (subscribed to its transcript). */
    viewed: (id: string): boolean => context().client.subscribers.subscriberCount(id) > 0,
    supportsCreate: (location: AgentSessionExecutionLocation, agent: string) =>
      providerSupport.adapterSupportsCreate(context().deps.adapter, location, agent),
    knownAgentIds: () => providerSupport.knownAgentIds(context().deps),
    revealSession: (id: string) => {
      const { deps, conversation } = context()
      return revealStructuredAgentSession(deps, id, conversation)
    },
    sessionAgent: (id: string) => context().deps.store.getConversation(id)?.provider ?? null,
    /** After an out-of-turn options write, so an open tab re-reads the chat's options. */
    publishStatus: (id: string) => context().publishStatus(id),
    /** The home a running child launched under. ACP adapters report none, so `orPinned` falls
     *  back to the record's pinned home while a child runs. */
    childAccountHome: (id: string, orPinned = false) => {
      const { sessions, deps } = context()
      const child = sessions.get(id)?.child
      return child && orPinned
        ? (child.accountHome ?? deps.store.getConversation(id)?.accountHome)
        : child?.accountHome
    },
    holdsSessions: () => context().deps.store.holdsRecords(),
    openConversationCount: () => context().sessions.size,
    /** Its agent is still starting: acquiring its process, or attached but not yet answering. */
    agentStarting: (id: string): boolean => {
      const { runtimeState, sessions } = context()
      return runtimeState.startFlights.has(id) || sessions.get(id)?.child?.phase === 'starting'
    },
    /** A decided start's acquire is still out, and no later start's child is attached. */
    startWindingDown: (id: string): boolean => {
      const { runtimeState, sessions } = context()
      return !sessions.get(id)?.child && runtimeState.startFlights.attempting(id)
    },
    /** A cancelled start's provider work, including releasing what it acquired, has ended. */
    startAttemptsEnded: (id: string) => context().runtimeState.startFlights.attemptsEnded(id),
    onSessionsHeld: (listener: () => void) => context().deps.store.onHeldChange(listener),
    prospectiveAccountHome: (id: string) => {
      const { deps, serialize } = context()
      return serialize(
        id,
        async () => (await deps.launchAccountHome?.(deps.store.requireWritableRecord(id))) ?? null
      )
    }
  }
}
