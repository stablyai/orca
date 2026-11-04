import {
  createStructuredAgentSessionCatalogReads,
  structuredAgentSessionCatalogScopeOwned
} from './structured-agent-session-catalog-reads'
import { revealStructuredAgentSession } from './structured-agent-session-reveal'
import type { StructuredAgentSessionClientDelivery } from './structured-agent-session-client-delivery'
import type { AgentSessionExecutionLocation } from '../../../shared/agent-session/lifecycle/agent-session-record'
import * as providerSupport from './structured-agent-session-provider-support'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'
import {
  queuedSendAnswer,
  structuredSendAnswer
} from './structured-agent-session-queued-send-answer'

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
  const readQueueStop = (sessionId: string) => {
    const journal = context().sessions.get(sessionId)?.journal
    if (!journal) {
      return undefined
    }
    const state = journal.queuedMessages.inputState()
    const stop = journal.queuedMessages.userStopInForce()
    return {
      epoch: state.epoch,
      stopSequence: stop?.sequence ?? 0,
      stopAt: stop?.event.at ?? null,
      resumedSequence: state.queuePauseMarks.resumedSequence,
      clearedSequence: state.queuePauseMarks.cleared?.sequence ?? 0
    }
  }
  return {
    readQueueStop,
    openQueueStop: async (sessionId: string) => {
      await context().conversation(sessionId)
      return readQueueStop(sessionId)
    },
    readModelCatalog,
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
