import type { CodexSubagentExecutions } from './codex-subagent-executions'
import { readCodexJournalRecord } from './codex-structured-journal-translation-values'
import {
  codexItemIdentity,
  CodexTurnOrdinals,
  readCodexThreadItem
} from './codex-structured-item-translation'
import type { AgentJournalItemIdentity } from '../../shared/agent-session-journal-types'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import {
  continuedOutsideNotice,
  runHistoryCatchUp
} from '../native-chat/agent-session-wire/structured-agent-session-history-catch-up'
import {
  DEFAULT_CODEX_REQUEST_TIMEOUT_MS,
  type CodexAppServerConnection
} from './codex-app-server-connection'
import { createCodexHistoryImportPlan } from './codex-history-import-plan'
import {
  discoverCodexHistory,
  loadCodexHistory,
  loadCodexReceiptHistory,
  selectCodexHistoryTurn
} from './codex-structured-thread-history-pages'
import {
  readCodexHistoryJournalView,
  sameCodexHistoryJournalView
} from './codex-history-journal-view'

// A chat writes its conversation only while its own app-server holds Codex's writer lock, so turns
// made anywhere else land only while the chat has no process; every process start opens here.

/** Optional reconciliation never gates provider open; an abandoned invocation cannot later write. */
export async function catchUpCodexThread(input: {
  connection: Pick<CodexAppServerConnection, 'request'>
  threadId: string
  returnedTurns?: readonly unknown[]
  paginate?: boolean
  subagentExecutions?: CodexSubagentExecutions
  sessionId: string
  sink: StructuredAgentSessionEventSink
  signal?: AbortSignal
  assertCurrent?: () => void
  timeoutMs?: number
  logger?: StructuredAgentSessionLogger
  onReceipt?: (
    clientMessageId: string,
    providerIdentity: AgentJournalItemIdentity
  ) => void | Promise<void>
}): Promise<void> {
  await runHistoryCatchUp({
    agentName: 'Codex',
    scope: 'codex-thread-catch-up',
    sessionId: input.sessionId,
    sink: input.sink,
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.assertCurrent ? { assertCurrent: input.assertCurrent } : {}),
    timeoutMs: input.timeoutMs ?? DEFAULT_CODEX_REQUEST_TIMEOUT_MS,
    ...(input.logger ? { logger: input.logger } : {}),
    readView: (history) => readCodexHistoryJournalView(history, input.threadId),
    sameView: sameCodexHistoryJournalView,
    prepare: async ({ view: readView, history, journal, signal, deadline, check, yieldTurn }) => {
      const view = readView()
      const read = {
        connection: input.connection,
        threadId: input.threadId,
        signal,
        deadline,
        check
      }
      const unresolved = new Set(view.unresolvedIds)
      const settle = async (
        clientMessageId: string,
        providerIdentity: AgentJournalItemIdentity
      ) => {
        check()
        if (input.sink.journalHistory?.() !== history || history.epoch !== view.epoch) {
          throw new Error('stale-history')
        }
        await waitForPromiseWithSignal(
          Promise.resolve(input.onReceipt?.(clientMessageId, providerIdentity)),
          signal
        )
        check()
      }
      const confirmReceipts = async (turn: Record<string, unknown>) => {
        check()
        if (!unresolved.size) {
          return
        }
        const ordinals = new CodexTurnOrdinals()
        for (const value of Array.isArray(turn.items) ? turn.items : []) {
          check()
          const item = readCodexThreadItem(value)
          if (!item || typeof turn.id !== 'string') {
            continue
          }
          const providerIdentity = codexItemIdentity({
            threadId: input.threadId,
            turnId: turn.id,
            item,
            ordinals,
            historyImport: true
          })
          if (
            item.type === 'userMessage' &&
            typeof item.clientId === 'string' &&
            unresolved.delete(item.clientId)
          ) {
            await settle(item.clientId, providerIdentity)
            if (!unresolved.size) {
              return
            }
          }
        }
      }
      const returned: Record<string, unknown>[] = []
      const seen = new Set<string>()
      for (const raw of input.returnedTurns ?? []) {
        check()
        const turn = readCodexJournalRecord(raw)
        if (typeof turn.id !== 'string' || !turn.id) {
          continue
        }
        if (seen.has(turn.id)) {
          throw new Error('repeated-turn')
        }
        seen.add(turn.id)
        returned.push(turn)
      }
      for (const turn of returned) {
        await confirmReceipts(turn)
        await yieldTurn()
      }
      const paginate = input.paginate !== false
      for await (const turn of paginate && unresolved.size ? loadCodexReceiptHistory(read) : []) {
        await confirmReceipts(turn)
        await yieldTurn()
        if (!unresolved.size) {
          break
        }
      }
      Object.assign(view, readCodexHistoryJournalView(history, input.threadId))
      const missing = paginate
        ? await discoverCodexHistory(read, view)
        : { pages: [], rewound: view.latest !== null && !seen.has(view.latest) }
      const staging = createCodexHistoryImportPlan({
        sessionId: input.sessionId,
        threadId: input.threadId,
        journal,
        nativePromptKeys: view.nativePromptKeys,
        subagentExecutions: input.subagentExecutions,
        outsideNotice: view.hasRows ? continuedOutsideNotice(missing.rewound) : undefined,
        check
      })
      try {
        const loaded = new Set<string>()
        for await (const turn of loadCodexHistory(read, missing.pages, confirmReceipts)) {
          check()
          staging.restore(turn)
          loaded.add(String(turn.id))
          await yieldTurn()
        }
        for (const turn of returned) {
          if (
            !loaded.has(String(turn.id)) &&
            turn.itemsView !== 'summary' &&
            selectCodexHistoryTurn(turn, {
              ...view,
              incomplete: new Set([
                ...(view.incomplete ?? []),
                ...(view.latest ? [view.latest] : [])
              ])
            })
          ) {
            staging.restore(turn)
            await yieldTurn()
          }
        }
        const plan = staging.finish()
        Object.assign(view, readCodexHistoryJournalView(history, input.threadId))
        return plan
      } finally {
        staging.dispose()
      }
    }
  })
}
