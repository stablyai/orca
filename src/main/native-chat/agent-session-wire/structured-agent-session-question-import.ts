import { parseAgentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentSessionConversationView } from '../../../shared/agent-session-conversation-view'
import {
  reconstructImport,
  isImportedQuestionRow,
  type QuestionImportJournal,
  type QuestionImportItem
} from './structured-agent-session-question-import-boundary'
import type { Boundary } from './structured-agent-session-question-import-fold'
import { isClippedToolInput } from '../agent-session-journal/journal-payload-bounds'
export { restoreImportedQuestionMessage } from './structured-agent-session-question-import-fold'

type Owner = {
  record: () => AgentSessionConversationView | null
  revision: number
  result?: Boundary
  capturedItems?: readonly QuestionImportItem[]
  importKey?: string
  running?: Promise<void>
  nextAttempt: number
  abort: AbortController
  load: (items: readonly QuestionImportItem[], signal: AbortSignal) => Promise<Boundary>
  wake: () => void
}
const owners = new WeakMap<QuestionImportJournal, Owner>()

/** The conversation owns source progress; view deadlines only release their own read interest. */
export function configureStructuredQuestionImport(
  journal: QuestionImportJournal,
  record: () => AgentSessionConversationView | null,
  workspacePath: (workspaceId: string) => Promise<string>,
  wake: () => void
): void {
  if (owners.has(journal)) {
    return
  }
  owners.set(journal, {
    record,
    revision: 0,
    nextAttempt: 0,
    abort: new AbortController(),
    wake,
    load: async (items, signal) => {
      const conversation = record()
      if (!conversation) {
        throw new Error('Question source no longer exists')
      }
      return reconstructImport(journal, conversation, items, workspacePath, signal)
    }
  })
}

export function releaseStructuredQuestionImport(journal: QuestionImportJournal): void {
  owners.get(journal)?.abort.abort()
  owners.delete(journal)
}

export function structuredQuestionImport(
  journal: QuestionImportJournal,
  items: readonly QuestionImportItem[]
): { revision: number; boundary: Boundary | null; clearOperationId?: string } {
  const owner = owners.get(journal)
  if (!owner) {
    return {
      revision: 0,
      boundary:
        journal.historyOrigin() || items.some(isImportedQuestionRow)
          ? null
          : { prefix: [], full: new Map() }
    }
  }
  if (owner.capturedItems !== items) {
    owner.capturedItems = items
    const dependencies = new Map<string, Set<string>>()
    for (const candidate of items) {
      if (!isImportedQuestionRow(candidate)) {
        continue
      }
      const { item } = candidate
      const values = dependencies.get(item.itemId) ?? new Set<string>()
      dependencies.set(item.itemId, values)
      const calls =
        item.body.kind === 'tool-call'
          ? [item.body]
          : item.body.kind === 'message'
            ? item.body.blocks.filter((block) => block.type === 'tool-call')
            : []
      values.add(
        JSON.stringify(
          calls.map((call, index) =>
            isClippedToolInput(call.input) ? [index, call.input.digest] : null
          )
        )
      )
    }
    const imported = parseAgentJournalItemKey(dependencies.keys().next().value ?? '')
    const origin = journal.historyOrigin()
    const adopted = owner.record()?.providerHandleChain.find((link) => link.origin === 'adopted')
    const identity = imported
      ? JSON.stringify(
          imported.provider === 'legacy'
            ? [imported.agent, imported.sessionId]
            : imported.provider === 'claude'
              ? ['claude', imported.sessionId]
              : imported
        )
      : origin || adopted
        ? JSON.stringify(origin?.raw ?? adopted?.handle)
        : undefined
    const key =
      identity === undefined
        ? undefined
        : JSON.stringify([
            identity,
            [...dependencies]
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([id, values]) => [id, [...values].sort()])
          ])
    if (owner.importKey !== key || (key === undefined && !owner.result)) {
      owner.importKey = key
      owner.abort.abort()
      owner.abort = new AbortController()
      owner.result = key === undefined ? { prefix: [], full: new Map() } : undefined
      owner.running = undefined
      owner.nextAttempt = 0
      owner.revision++
    }
  }
  if (!owner.result && !owner.running && Date.now() >= owner.nextAttempt) {
    const signal = owner.abort.signal
    owner.running = owner
      .load(items, signal)
      .then((result) => {
        if (signal.aborted) {
          return
        }
        owner.result = result
        owner.revision++
        // Install first; a getter must never recursively emit a subscriber frame.
        queueMicrotask(() => {
          if (!signal.aborted) {
            owner.wake()
          }
        })
      })
      .catch(() => {
        if (!signal.aborted) {
          owner.nextAttempt = Date.now() + 750
        }
      })
      .finally(() => {
        if (!signal.aborted) {
          owner.running = undefined
        }
      })
  }
  return {
    revision: owner.revision,
    boundary: owner.result ?? null,
    clearOperationId: owner.record()?.providerContextBoundary?.operationId
  }
}
