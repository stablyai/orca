import { journalContextCursor, projectJournalRows } from './journal-context-cursor'
import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalSnapshot } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentSessionJournalOptions, JournalReadSince } from './journal-store-contracts'

import type { JournalReducerState } from './journal-reducer'
import type { readJournalPublicView } from './journal-public-read'
import { readJournalSinceAsync } from './journal-cursor'
import { readJournalRowsAfterCursorAsync } from './journal-async-open'
import { captureJournalReadView } from './journal-read-view'

type PublicRead = ReturnType<typeof readJournalPublicView>

/** Pair durable snapshots with the host's published values for the lifetime of one request. */
export class JournalHistoryReader {
  constructor(
    private readonly options: Pick<AgentSessionJournalOptions, 'database' | 'identity'>,
    private readonly state: () => JournalReducerState,
    private readonly publicRead: () => PublicRead
  ) {}

  readSince(cursor: AgentJournalCursor, limit?: number) {
    return this.readCapturedSince(
      cursor,
      limit,
      () => undefined,
      (since) => since
    )
  }

  /** Materialize selected request facts before later publication; retain concurrent point changes only. */
  readSinceView<T, Context>(
    cursor: AgentJournalCursor,
    limit: number,
    capture: (view: PublicRead) => Context,
    consume: (
      since: JournalReadSince,
      view: PublicRead,
      canonicalItemId: (id: string) => string,
      context: Context,
      facts: Pick<
        ReturnType<typeof captureJournalReadView>,
        'hasSubmission' | 'queueSourceIds' | 'snapshotForItems'
      >
    ) => T,
    materialize: (view: PublicRead) => AgentJournalSnapshot = (view) => view.currentSnapshot()
  ): Promise<T> {
    return this.readCapturedSince(
      cursor,
      limit,
      () => {
        const view = this.publicRead()
        const materialized = capturedView(materialize(view), view.normalizationKey)
        const context = capture(materialized)
        return {
          capture: captureJournalReadView(this.state(), materialized.snapshot),
          normalizationKey: materialized.normalizationKey,
          context
        }
      },
      (since, retained) =>
        consume(
          since,
          capturedView(retained.capture.snapshot(), retained.normalizationKey),
          retained.capture.canonical,
          retained.context,
          retained.capture
        ),
      (retained) => retained.capture.close()
    )
  }

  private async readCapturedSince<T, View>(
    cursor: AgentJournalCursor,
    limit: number | undefined,
    capture: () => View,
    consume: (since: JournalReadSince, view: View) => T,
    release: (view: View) => void = () => {}
  ): Promise<T> {
    const request = await this.options.database.snapshot(() => ({
      state: {
        epoch: journalContextCursor(this.state()).epoch,
        physicalEpoch: this.state().epoch,
        contextBoundary: this.state().contextBoundary,
        lastSequence: this.state().lastSequence,
        oldestSequence: this.state().oldestSequence
      },
      view: capture()
    }))
    try {
      const { state, view } = request.view
      const since = await readJournalSinceAsync(
        {
          state,
          rowsAfter: async (after) => {
            const read = await readJournalRowsAfterCursorAsync(
              request.read,
              this.options.identity.sessionId,
              state.physicalEpoch,
              after,
              limit
            )
            return {
              ...read,
              rows: projectJournalRows(
                { epoch: state.physicalEpoch, contextBoundary: state.contextBoundary },
                read.rows
              )
            }
          }
        },
        cursor
      )
      return consume(since, view)
    } finally {
      try {
        await request.close()
      } finally {
        release(request.view.view)
      }
    }
  }
}

function capturedView(snapshot: PublicRead['snapshot'], normalizationKey: string): PublicRead {
  const selected = (ids: ReadonlySet<string>) => ({
    ...snapshot,
    submissions: snapshot.submissions.filter((input) =>
      ids.has(agentJournalSubmissionKey(input.clientMessageId))
    )
  })
  return {
    snapshot,
    normalizationKey,
    currentSnapshot: () => snapshot,
    snapshotForItems: selected
  }
}
