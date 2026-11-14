import {
  createStructuredAgentSessionCatalogReads,
  structuredAgentSessionCatalogScopeOwned
} from '../options/structured-agent-session-catalog-reads'
import { revealStructuredAgentSession } from './structured-agent-session-reveal'
import type { StructuredAgentSessionClientDelivery } from '../publication/subscribers/structured-agent-session-client-delivery'
import type { AgentSessionExecutionLocation } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import type { StructuredAttentionRead } from '../../../../shared/agent-session/agent-session-attention'
import * as providerSupport from '../providers/structured-agent-session-provider-support'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'
import { readAgentJournalPage } from '../publication/history/agent-read-journal-page'
import { hostStructuredAgentSessionCurrentWork } from '../observations/structured-agent-session-host-current-work'
import {
  queuedSendAnswer,
  structuredSendAnswer
} from '../delivery/structured-agent-session-queued-send-answer'

type ReadContext = {
  deps: StructuredAgentSessionHostDeps
  sessions: Map<string, StructuredAgentSessionHostSession>
  serialize: <T>(id: string, task: () => Promise<T>) => Promise<T>
  readCommands: StructuredAgentSessionClientDelivery['readCommandsSettled']
  conversation: (id: string) => Promise<StructuredAgentSessionHostSession>
}

/** Readers share the conversation owner; inventory never founds a journal or prepares a provider. */
export function createStructuredAgentSessionConversationReads(context: () => ReadContext) {
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
    journalCurrentRead: async (sessionId: string, inputIds?: readonly string[]) =>
      (await context().conversation(sessionId)).journal.currentRead(inputIds),
    /** One `orca agent read` page, opened at rest; a pending prompt waits only while the held
     *  session can still answer it, and every pending one does with no session held. */
    agentReadPage: async (
      sessionId: string,
      request: Parameters<typeof readAgentJournalPage>[1]
    ) => {
      const journal = await journalOf(sessionId)
      const { deps, sessions } = context()
      const work = hostStructuredAgentSessionCurrentWork({ store: deps.store, sessions }, sessionId)
      return readAgentJournalPage(journal, request, (itemId) => work?.isCurrentItem(itemId) ?? true)
    },

    readModelCatalog,
    attentionReads: {
      workspace: async (
        location: AgentSessionExecutionLocation
      ): Promise<(StructuredAttentionRead & { scope: AgentSessionExecutionLocation })[]> => {
        const { deps, sessions } = context()
        const reads = await Promise.all(
          deps.store.workspaceAttentionReads(location).map(async (read) => {
            const journal = sessions.get(read.sessionId)?.journal
            try {
              return journal
                ? { ...read, observedCursor: await journal.readInOrder(journal.cursor) }
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
    queuedSendAnswer: async (id: string, messageId: string) =>
      queuedSendAnswer(await journalOf(id), messageId),
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
