import { isDeepStrictEqual } from 'node:util'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey,
  parseAgentJournalItemKey
} from '../../shared/agent-session/journal/agent-session-journal-item-key'
import {
  agentJournalTurnBody,
  readAgentJournalTurn
} from '../../shared/agent-session/lifecycle/agent-session-turn-record'
import type {
  AgentJournalProducerLinkage,
  AgentJournalRenderItem
} from '../../shared/agent-session/journal/agent-session-journal-types'
import {
  createHistoryCatchUpBatch,
  runHistoryCatchUp
} from '../native-chat/agent-session-wire/acquisition/structured-agent-session-history-catch-up'
import { nativeCopyCoverage } from '../native-chat/agent-session-journal/context-epochs/journal-history-origin'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/host/structured-agent-session-logger'
import type { TraexAppServerConnection } from './traex-app-server-connection'
import { projectTraexHistoryTurn } from './traex-history-projection'
import { createTraexTimelineItemKeyResolver } from './traex-timeline-item-key'
import {
  traexRecord,
  traexText,
  traexTurnSchema,
  traexThreadResponseSchema,
  TraexRequestError,
  type TraexTurn
} from './traex-protocol'

export async function readTraexTurns(
  connection: TraexAppServerConnection,
  threadId: string,
  check: () => void
): Promise<TraexTurn[]> {
  const turns: TraexTurn[] = []
  const cursors = new Set<string>()
  let cursor: string | undefined
  do {
    check()
    const page = await connection
      .request('thread/turns/list', {
        threadId,
        sortDirection: 'asc',
        itemsView: 'full',
        limit: 100,
        ...(cursor ? { cursor } : {})
      })
      .then(traexRecord)
      .catch(async (error: unknown) => {
        if (cursor || !(error instanceof TraexRequestError) || error.code !== -32601) {
          throw error
        }
        check()
        const result = traexThreadResponseSchema.parse(
          await connection.request('thread/read', {
            threadId,
            includeTurns: true
          })
        )
        if (result.thread.id !== threadId || !result.thread.turns) {
          throw new Error('TRAE CLI did not return the requested thread history')
        }
        return traexRecord({ data: result.thread.turns })
      })
    if (!Array.isArray(page.data)) {
      throw new Error('TRAE CLI did not return thread history')
    }
    turns.push(...page.data.map((turn) => traexTurnSchema.parse(turn)))
    if (turns.length > 10_000) {
      throw new Error('TRAE CLI history exceeds the import limit')
    }
    cursor = traexText(page.nextCursor)
    if (cursor && cursors.has(cursor)) {
      throw new Error('TRAE CLI repeated a history cursor')
    }
    if (cursor) {
      cursors.add(cursor)
    }
  } while (cursor)
  return turns
}

export async function catchUpTraexHistory(input: {
  connection: TraexAppServerConnection
  threadId: string
  sessionId: string
  sink: StructuredAgentSessionEventSink
  signal: AbortSignal
  logger?: StructuredAgentSessionLogger
  turns?: TraexTurn[]
  primaryThreadId?: string
  producer?: AgentJournalProducerLinkage
}): Promise<void> {
  await runHistoryCatchUp({
    agentName: 'TRAE CLI',
    scope: 'traex-history',
    sessionId: input.sessionId,
    sink: input.sink,
    signal: input.signal,
    timeoutMs: 30_000,
    logger: input.logger,
    readView: (history) => {
      const items = new Map<string, AgentJournalRenderItem>()
      const commandTurns = new Set<string>()
      history.visitItems((key) => {
        const item = history.item(key)
        if (item) {
          items.set(key, item)
          const turn = readAgentJournalTurn(item.body)
          if (
            parseAgentJournalItemKey(key)?.provider === 'orca' &&
            turn?.state === 'completed' &&
            turn.providerTurnId
          ) {
            commandTurns.add(turn.providerTurnId)
          }
        }
      })
      return {
        items,
        commandTurns,
        token: JSON.stringify(history.cursor()),
        covered: nativeCopyCoverage(history.historyOrigin(), 'trae', 'traex-turn', {
          kind: 'opaque',
          agent: 'trae',
          value: input.threadId
        })
      }
    },
    sameView: (a, b) => a.token === b.token,
    prepare: async ({ view, check, yieldTurn, history }) => {
      const baseline = view()
      const turns = input.turns ?? (await readTraexTurns(input.connection, input.threadId, check))
      const batch = createHistoryCatchUpBatch()
      const itemKey = createTraexTimelineItemKeyResolver({
        sessionId: input.sessionId,
        threadId: input.threadId,
        journal: () => history
      })
      for (const turn of turns) {
        check()
        if (baseline.covered?.has(turn.id) || baseline.commandTurns.has(turn.id)) {
          continue
        }
        const user = turn.items?.find((item) => item.type === 'userMessage')
        const clientId = user && (traexText(user.clientId) ?? user.id)
        const represented = clientId && baseline.items.has(agentJournalSubmissionKey(clientId))
        const mutations = projectTraexHistoryTurn({
          threadId: input.threadId,
          sessionId: input.sessionId,
          turn,
          epoch: history.epoch,
          itemKey,
          primaryThreadId: input.primaryThreadId,
          producer: input.producer,
          ...(represented && clientId ? { representedClientId: clientId } : {})
        })
        for (const mutation of mutations) {
          const key = agentJournalItemKey(mutation.identity)
          const saved = baseline.items.get(key)
          const lifecycle = readAgentJournalTurn(mutation.body)
          const oldTurn = saved && readAgentJournalTurn(saved.body)
          const body = lifecycle
            ? agentJournalTurnBody({
                ...lifecycle,
                userItemId:
                  oldTurn?.userItemId ??
                  (represented && clientId
                    ? agentJournalSubmissionKey(clientId)
                    : lifecycle.userItemId),
                ...(oldTurn?.outcome === 'cancellation'
                  ? { state: oldTurn.state, outcome: oldTurn.outcome }
                  : {})
              })
            : mutation.body
          if (!saved) {
            batch.push({ ...mutation, body })
          } else if (!isDeepStrictEqual(saved.body, body)) {
            batch.revise(
              { ...mutation, body, turnScope: saved.turnScope ?? mutation.turnScope },
              { canonicalItemId: key, revision: saved.revision }
            )
          }
        }
        await yieldTurn()
      }
      return batch.size
        ? batch.finish('traex-history', [
            history.epoch,
            input.threadId,
            turns.map((turn) => turn.id)
          ])
        : null
    }
  })
}
