import {
  capturePublishedWorkSteps,
  type AgentSessionPublishedWork
} from './agent-session-published-work'
import { readForward, readForwardFinite } from './agent-session-history-forward-page'
import type { HistoryReader } from './agent-session-history-page-bounds'
import {
  readJournalDerived,
  journalDerivedRefreshPending
} from '../agent-session-journal/journal-derived-read'
import {
  finishJournalSteps,
  finishJournalStepsAsync
} from '../agent-session-journal/journal-reconstruction-steps'
import {
  readHistoryMemorySteps,
  buildHydrationPage,
  buildHydrationPageSteps,
  historyResetSteps,
  historyReset
} from './agent-session-history-page-fields'
import { resolveHistoryLimit } from './agent-session-history-limit'

// Backward pages use the reduced timeline so compaction retains live items. Catch-up reads rows:
// late revisions keep old creation positions and would be skipped by item windows. Only catch-up
// can therefore return cursor_compacted.

import type { AgentJournalSnapshot } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { CLIENT_HISTORY_READER } from './agent-session-item-wire-form'
export { resolveHistoryLimit } from './agent-session-history-limit'
// Backward pages use the reduced timeline so compaction retains live items. Catch-up reads rows:
// late revisions keep old creation positions and would be skipped by item windows. Only catch-up
// can therefore return cursor_compacted.

import type {
  AgentSessionHistoryPage,
  AgentSessionHistoryRequest,
  AgentSessionHistoryResult
} from '../../../shared/agent-session/agent-session-wire'

export { AGENT_SESSION_HISTORY_MAX_PAGE_BYTES } from './agent-session-history-page-bounds'

/** In-process only: both scopes window by own-agent rows; own-agent also excludes other producers. */
export type AgentSessionHistoryScope = 'every-agent' | 'own-agent'

export type HistoryReadOptions = {
  /** Reuse a snapshot across synchronous catch-up pages to avoid repeated full reduction. */
  captureResult?: (
    snapshot: AgentJournalSnapshot,
    view: Pick<
      ReturnType<AgentSessionJournal['publicRead']>,
      'snapshot' | 'normalizationKey' | 'currentSnapshot'
    >
  ) => (result: AgentSessionHistoryResult) => AgentSessionHistoryResult
  finite?: true
  captureResultSteps?: (
    snapshot: AgentJournalSnapshot,
    view: NonNullable<HistoryReadOptions['view']>
  ) => Generator<void, (result: AgentSessionHistoryResult) => AgentSessionHistoryResult>
  snapshot?: AgentJournalSnapshot
  view?: Pick<
    ReturnType<AgentSessionJournal['publicRead']>,
    'snapshot' | 'normalizationKey' | 'currentSnapshot'
  >
  scope?: AgentSessionHistoryScope
  reader?: HistoryReader
  /** Internal catch-up and older item-backed clients keep their existing row replay. */
  rowReplay?: boolean
}

export function readAgentSessionHistory(
  journal: AgentSessionJournal,
  request: AgentSessionHistoryRequest,
  options: HistoryReadOptions = {}
): AgentSessionHistoryResult | Promise<AgentSessionHistoryResult> {
  return readPreparedHistory(journal, request, options)
}

function readPreparedHistory(
  journal: AgentSessionJournal,
  request: AgentSessionHistoryRequest,
  options: HistoryReadOptions = {},
  finite = false,
  queueSources?: ReadonlyMap<string, readonly string[]>
): AgentSessionHistoryResult | Promise<AgentSessionHistoryResult> {
  if (journalDerivedRefreshPending(journal) || options.finite) {
    return journal.readInOrder(async () => {
      await finishJournalStepsAsync(journal.preparePublicReadSteps())
      const sources = new Map<string, readonly string[]>()
      if (options.reader?.queueSourceIds) {
        await finishJournalStepsAsync(
          (function* () {
            for (const card of journal.queuedMessages.list()) {
              sources.set(card.messageId, options.reader!.queueSourceIds!(journal, card.messageId))
              yield
            }
          })()
        )
      }
      const view = journal.publicRead()
      const base = view.currentSnapshot()
      const snapshot = options.reader?.snapshot?.(journal, base) ?? base
      const apply = options.captureResultSteps
        ? await finishJournalStepsAsync(options.captureResultSteps(snapshot, view))
        : undefined
      return readPreparedHistory(
        journal,
        request,
        {
          ...options,
          finite: undefined,
          view: undefined,
          snapshot: undefined,
          ...(apply ? { captureResult: () => apply } : {})
        },
        true,
        sources
      )
    })
  }
  const reader = options.reader ?? CLIENT_HISTORY_READER
  const decorate = options.captureResult ?? (() => (result: AgentSessionHistoryResult) => result)
  if (request.direction !== 'after' || !request.cursor) {
    const view = options.view ?? journal.publicRead()
    const base = options.snapshot ?? view.currentSnapshot()
    const snapshot = reader.snapshot?.(journal, base) ?? base
    const result =
      request.direction === 'after'
        ? finite
          ? finishJournalStepsAsync(historyResetSteps(snapshot, 'cursor_ahead', reader))
          : historyReset(snapshot, 'cursor_ahead', reader)
        : finite
          ? finishJournalStepsAsync(
              readHistoryMemorySteps(request, snapshot, options.scope ?? 'every-agent', reader)
            )
          : readHistoryMemory(journal, request, { ...options, view, snapshot })
    const apply = decorate(snapshot, view)
    return result instanceof Promise ? result.then(apply) : apply(result)
  }
  const cursor = request.cursor
  const limit = resolveHistoryLimit(request.limit)
  return journal.readSinceView(
    cursor,
    limit + 1,
    (view) => ({
      apply: decorate(view.snapshot, view),
      queueSources:
        queueSources ??
        new Map(
          reader.queueSourceIds
            ? journal.queuedMessages
                .list()
                .map(
                  (card) =>
                    [card.messageId, reader.queueSourceIds!(journal, card.messageId)] as const
                )
            : []
        )
    }),
    (since, view, canonical, captured) => {
      const snapshot = view.snapshot
      const reset = async (reason: Extract<AgentSessionHistoryResult, { ok: false }>['reset']) => {
        const stable = await finishJournalStepsAsync(view.snapshotSteps())
        return finishJournalStepsAsync(historyResetSteps(stable, reason, reader))
      }
      const result =
        !options.rowReplay &&
        cursor.epoch === snapshot.cursor.epoch &&
        cursor.sequence <= snapshot.cursor.sequence &&
        view.normalizationKey !== ''
          ? reset('cursor_compacted')
          : (finite ? readForwardFinite : readForward)(
              snapshot,
              cursor,
              limit,
              reader,
              since,
              canonical,
              (id) => captured.queueSources.get(id) ?? [],
              reset
            )
      const apply = (result: AgentSessionHistoryResult) => structuredClone(captured.apply(result))
      return result instanceof Promise ? result.then(apply) : apply(result)
    },
    (snapshot) => reader.snapshot?.(journal, snapshot) ?? snapshot
  )
}

function readHistoryMemory(
  journal: AgentSessionJournal,
  request: AgentSessionHistoryRequest,
  {
    view = journal.publicRead(),
    snapshot,
    scope = 'every-agent',
    reader = CLIENT_HISTORY_READER
  }: HistoryReadOptions = {}
): AgentSessionHistoryResult {
  return finishJournalSteps(
    readHistoryMemorySteps(request, snapshot ?? view.currentSnapshot(), scope, reader)
  )
}

/** Reuse reduced state until the complete journal source changes. */
export function createAgentSessionCatchUpReader(
  journal: AgentSessionJournal,
  reader: HistoryReader = CLIENT_HISTORY_READER,
  initialView: NonNullable<HistoryReadOptions['view']> = journal.publicRead(),
  captureResult?: HistoryReadOptions['captureResult'],
  captureResultSteps?: HistoryReadOptions['captureResultSteps'],
  finite = false
): (request: AgentSessionHistoryRequest) => Promise<AgentSessionHistoryResult> {
  let view = initialView
  return async (request) => {
    const live = journal.publicRead()
    if (view !== live) {
      view = live
    }
    return readAgentSessionHistory(journal, request, {
      view,
      reader,
      rowReplay: true,
      captureResult,
      captureResultSteps,
      ...(finite ? { finite: true } : {})
    })
  }
}

/** Capture current derived state only after the replacement's finite completion. */
export function readAgentSessionHydration(
  journal: AgentSessionJournal,
  fence?: number,
  reader: HistoryReader = CLIENT_HISTORY_READER,
  select: (view: ReturnType<AgentSessionJournal['publicRead']>) => AgentJournalSnapshot = (view) =>
    view.currentSnapshot(),
  readWork?: () => AgentSessionPublishedWork | undefined
) {
  return readJournalDerived(journal, function* (finite) {
    if (finite) {
      yield* journal.preparePublicReadSteps()
    }
    const view = journal.publicRead()
    const snapshot = select(view)
    const page = yield* buildHydrationPageSteps(
      reader.snapshot?.(journal, snapshot) ?? snapshot,
      fence,
      reader
    )
    let work = readWork?.()
    if (finite && readWork) {
      for (;;) {
        const captured = yield* capturePublishedWorkSteps(snapshot, work)
        const next = readWork()
        if (work?.viewKey() === next?.viewKey() && work?.revision === next?.revision) {
          work = captured
          break
        }
        work = next
        yield
      }
    }
    return { page, view, work }
  })
}

export function readAgentSessionHydrationPage(
  journal: AgentSessionJournal,
  fence?: number,
  reader: HistoryReader = CLIENT_HISTORY_READER,
  snapshot: AgentJournalSnapshot = journal.currentRead()
): AgentSessionHistoryPage {
  return buildHydrationPage(reader.snapshot?.(journal, snapshot) ?? snapshot, fence, reader)
}
