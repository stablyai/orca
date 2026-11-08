import { agentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalMessageItem
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalItemIdentity } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentJournalTurnScope } from '../../../../shared/agent-session/journal/agent-session-journal-turn-scope'
import { journalItemRowBuilder } from './journal-row-builders'
import type { JournalReducerState } from '../projection/journal-reducer'
import type {
  JournalAppendResult,
  JournalItemAppendOptions,
  JournalShutdownCutInput
} from '../journal-store-contracts'
import {
  readAgentJournalTurn,
  readAgentJournalTurnOutcome
} from '../../../../shared/agent-session/lifecycle/agent-session-turn-record'
import { agentTurnVerdict } from '../../../../shared/agent-status/lifecycle/agent-turn-outcome'
import { readJournalInputItem } from '../input-order/journal-input-obligations'
import type { JournalRow } from '../durable-rows/journal-row-schema'
import type { JournalOperationReceipt, JournalRowWriter } from './journal-row-writer'
import type {
  JournalAttachmentClaim,
  journalInputClaimsReceipt
} from '../submissions/journal-submission-hook'

// Module-level Error stacks retain startup code and buffers; construct them only when needed.
class NothingResolvedError extends Error {}

export type JournalResolvedItem = {
  identity: AgentJournalItemIdentity
  body: AgentJournalItemBody
  turnScope?: AgentJournalTurnScope
}

export class JournalItemAppender {
  constructor(
    private readonly deps: {
      inputReceipt: (
        rows: readonly JournalRow[],
        receipt?: JournalOperationReceipt
      ) => ReturnType<typeof journalInputClaimsReceipt>
      state: () => JournalReducerState
      enqueue: JournalRowWriter['enqueue']
      claimAttachments: JournalAttachmentClaim
    }
  ) {}

  append(
    identity: AgentJournalItemIdentity,
    body: AgentJournalItemBody,
    options: JournalItemAppendOptions,
    receipt?: JournalOperationReceipt
  ): Promise<JournalAppendResult> {
    const itemId = agentJournalItemKey(identity)
    return this.deps
      .enqueue(journalItemRowBuilder(this.deps.state, identity, body, options), (rows) =>
        this.deps.inputReceipt(rows, receipt)
      )
      .then((row) => appendResult(row, itemId))
  }

  /** A client-authored message claims the uploads it names with its row; a swept one refuses both. */
  appendClaimingAttachments(
    identity: AgentJournalItemIdentity,
    body: AgentJournalMessageItem,
    options: JournalItemAppendOptions
  ): Promise<JournalAppendResult> {
    let committed: (() => void) | void
    return this.deps
      .enqueue(journalItemRowBuilder(this.deps.state, identity, body, options), {
        write: (db) => {
          committed = this.deps.claimAttachments(
            db,
            body,
            true,
            undefined,
            body.sentAs === 'goal' ? agentJournalItemKey(identity) : undefined
          )
        },
        committed: () => committed?.()
      })
      .then((row) => appendResult(row, agentJournalItemKey(identity)))
  }

  /** Quit explains only an interrupted turn; earlier settlement/replay is read at this write. */
  appendShutdownCut(input: JournalShutdownCutInput): Promise<JournalAppendResult | null> {
    return this.appendResolved(
      () => {
        const state = this.deps.state()
        const turn = readAgentJournalTurn(readJournalInputItem(state, input.turnItemId)?.body)
        return readJournalInputItem(state, agentJournalItemKey(input.identity)) ||
          !turn ||
          agentTurnVerdict({ state: turn.state, outcome: readAgentJournalTurnOutcome(turn) }) !==
            'interruption'
          ? null
          : { identity: input.identity, body: input.body }
      },
      { fence: input.fence, turnScope: { kind: 'turn', turnItemId: input.turnItemId } }
    )
  }

  /** Resolve against preceding queued writes; null appends nothing. */
  appendResolved(
    resolve: () => JournalResolvedItem | null,
    options: JournalItemAppendOptions
  ): Promise<JournalAppendResult | null> {
    let itemId = ''
    return this.deps
      .enqueue(
        (seq, ts) => {
          const resolved = resolve()
          if (resolved === null) {
            throw new NothingResolvedError('journal_item_resolved_to_nothing')
          }
          itemId = agentJournalItemKey(resolved.identity)
          return journalItemRowBuilder(
            this.deps.state,
            resolved.identity,
            resolved.body,
            options
          )(seq, ts)
        },
        (rows) => this.deps.inputReceipt(rows)
      )
      .then(
        (row) => appendResult(row, itemId),
        (error: unknown) => {
          if (error instanceof NothingResolvedError) {
            return null
          }
          throw error
        }
      )
  }
}

function appendResult(row: JournalRow, itemId: string): JournalAppendResult {
  return {
    cursor: { epoch: row.epoch, sequence: row.seq },
    itemId,
    revision: (row as Extract<JournalRow, { kind: 'item' }>).revision
  }
}
