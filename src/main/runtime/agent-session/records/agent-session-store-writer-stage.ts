import type {
  JournalReceiptStage,
  JournalStagedReceipt
} from '../../../native-chat/agent-session-journal/writing/journal-row-writer'
import {
  requireWritableAgentSessionRecord,
  type AgentSessionStoreState
} from './agent-session-store-state'
import type { StagedStoreTransaction } from './agent-session-store-transactions'
import { draftAgentSessionStoreState } from './agent-session-store-draft'
import { adoptAgentSessionStoreResolvedRows } from './agent-session-store-resolved-rows'

type StoreWriterLane = {
  draft: AgentSessionStoreState
  resolved: AgentSessionStoreState
  pending: number
  committed: boolean
  failed: boolean
  /** Staged receipts not yet settled; the lane releases when none remain. */
  open: number
  release: () => void
}

/** A send admitted on a slept record wakes it in the same draft. */
function wakeAdmittedRecord(
  draft: AgentSessionStoreState,
  admitted: string | undefined,
  at: number | undefined
): void {
  const record = admitted ? requireWritableAgentSessionRecord(draft, admitted) : undefined
  if (record?.sleptAt !== undefined) {
    const { sleptAt: _sleptAt, ...awake } = record
    draft.records.set(record.sessionId, { ...awake, updatedAt: at ?? record.updatedAt })
  }
}

/** One writer command holds the store lane from its first staged receipt until all settle. */
export class AgentSessionStoreWriterLanes {
  private readonly lanes = new WeakMap<JournalReceiptStage, StoreWriterLane>()

  constructor(
    /** Joins the store's FIFO lane, shared with transact(). */
    private readonly enqueue: (hold: () => Promise<void>) => void,
    private readonly published: () => AgentSessionStoreState
  ) {}

  hold(context: JournalReceiptStage): Promise<StoreWriterLane> {
    const held = this.lanes.get(context)
    if (held) {
      return Promise.resolve(held)
    }
    return new Promise((resolve) => {
      this.enqueue(
        () =>
          new Promise<void>((release) => {
            const draft = this.published()
            const lane = {
              draft,
              resolved: draftAgentSessionStoreState(draft),
              pending: 0,
              committed: false,
              failed: false,
              open: 0,
              release
            }
            this.lanes.set(context, lane)
            resolve(lane)
          })
      )
    })
  }

  settle(context: JournalReceiptStage, lane: StoreWriterLane): void {
    if (lane.open === 0 && this.lanes.get(context) === lane) {
      this.lanes.delete(context)
      lane.release()
    }
  }
}

/** Stage for the worker writer: the draft rides as an effect and is adopted only after its COMMIT. */
export async function stageAgentSessionStoreReceipt(
  deps: {
    refusal: () => Error | undefined
    lanes: AgentSessionStoreWriterLanes
    stage: (
      apply: (draft: AgentSessionStoreState) => void,
      base: AgentSessionStoreState
    ) => StagedStoreTransaction<void>
    admit: (sessionId: string) => void
    publish: (draft: AgentSessionStoreState) => void
    fault: (error: Error) => void
  },
  receipt: {
    apply: (draft: AgentSessionStoreState) => void
    insertOperationsIfAbsent?: true
    submissionSessionId?: string
  },
  context: JournalReceiptStage
): Promise<JournalStagedReceipt> {
  const refusal = deps.refusal()
  if (refusal) {
    throw refusal
  }
  const lane = await deps.lanes.hold(context)
  const admitted = context.row === 'submission' ? receipt.submissionSessionId : undefined
  let staged: StagedStoreTransaction<void>
  try {
    staged = deps.stage((draft) => {
      receipt.apply(draft)
      wakeAdmittedRecord(draft, admitted, context.savedAt)
    }, lane.draft)
  } catch (error) {
    deps.lanes.settle(context, lane)
    throw error
  }
  lane.draft = staged.draft
  lane.open++
  lane.pending++
  const { writes } = staged
  let resolved = false
  let settled = false
  const adopt: NonNullable<JournalStagedReceipt['adopt']> = (results) => {
    if (resolved) {
      return
    }
    resolved = true
    lane.pending--
    try {
      if (results !== undefined) {
        if (results.length !== (writes ? 1 : 0)) {
          throw new Error('the writer returned missing store results')
        }
        for (const result of results) {
          if (
            !result ||
            typeof result !== 'object' ||
            !('kind' in result) ||
            result.kind !== 'store'
          ) {
            throw new Error('the writer returned a different store result')
          }
          adoptAgentSessionStoreResolvedRows(lane.resolved, result.writes)
        }
        lane.committed = true
      }
      if (lane.pending === 0 && lane.committed && !lane.failed) {
        deps.publish(lane.resolved)
      }
    } catch (error) {
      lane.failed = true
      deps.fault(error instanceof Error ? error : new Error(String(error)))
      throw error
    }
  }
  return {
    effects: writes
      ? [{ kind: 'store', writes, insertOperationsIfAbsent: !!receipt.insertOperationsIfAbsent }]
      : [],
    adopt,
    settle: (results) => {
      if (settled) {
        return
      }
      settled = true
      try {
        adopt(results)
        if (results !== undefined && !lane.failed && admitted) {
          deps.admit(admitted)
        }
      } finally {
        lane.open--
        deps.lanes.settle(context, lane)
      }
    }
  }
}
