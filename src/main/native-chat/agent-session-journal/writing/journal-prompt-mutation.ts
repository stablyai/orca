import type {
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import {
  refuse,
  AgentSessionRefusalError,
  type AgentSessionWireRefusal
} from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
import { parseAgentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { JournalPromptMutationInput, JournalAppendResult } from '../journal-store-contracts'
import type { JournalReducerState } from '../projection/journal-reducer'
import { readJournalInputItem } from '../input-order/journal-input-obligations'
import { journalContextCursor } from '../context-epochs/journal-context-epoch'
import { journalItemRowBuilder } from './journal-row-builders'
import type { JournalRowWriter, JournalOperationReceipt } from './journal-row-writer'

export type PendingPromptBody = Extract<AgentJournalItemBody, { kind: 'approval' | 'question' }>
export type PendingPromptValidation =
  | { ok: true; item: AgentJournalRenderItem; prompt: PendingPromptBody }
  | { ok: false; refusal: AgentSessionWireRefusal }

function promptGone(message: string): PendingPromptValidation {
  return {
    ok: false,
    refusal: refuse('agent_session_operation_invalid', { reason: 'promptGone' }, message)
  }
}

export function validateJournalPendingPrompt(
  item: AgentJournalRenderItem | undefined,
  sessionId: string,
  input: {
    itemId: string
    expectedRevision: number
    kind?: 'approval' | 'question'
  }
): PendingPromptValidation {
  if (!item) {
    return promptGone(`No item ${input.itemId} in session ${sessionId}.`)
  }
  const prompt = item.body.kind === 'approval' || item.body.kind === 'question' ? item.body : null
  if (!prompt || (input.kind !== undefined && prompt.kind !== input.kind)) {
    return promptGone(
      `Item ${input.itemId} is not a pending${input.kind ? ` ${input.kind}` : ' prompt'}.`
    )
  }
  if (item.revision !== input.expectedRevision) {
    return {
      ok: false,
      refusal: refuse(
        'agent_session_item_revision_stale',
        { reason: 'promptMoved', currentRevision: item.revision, resolution: prompt.resolution },
        `Item ${input.itemId} has moved on.`
      )
    }
  }
  if (prompt.resolution.state !== 'pending') {
    return {
      ok: false,
      refusal: refuse(
        'agent_session_already_resolved',
        {
          reason: 'promptAlreadyResolved',
          currentRevision: item.revision,
          resolution: prompt.resolution
        },
        `Item ${input.itemId} was already ${prompt.resolution.state}.`
      )
    }
  }
  return { ok: true, item, prompt }
}

/** Recheck the revision and derive the body after preceding provider/settlement writes. */
export async function mutateJournalPrompt(
  deps: { state: () => JournalReducerState; writer: JournalRowWriter },
  input: JournalPromptMutationInput,
  receipt?: JournalOperationReceipt
): Promise<JournalAppendResult> {
  let unchanged: JournalAppendResult | undefined
  const rows = await deps.writer.enqueueRows(
    () => {
      const state = deps.state()
      const current = readJournalInputItem(state, input.itemId)
      if (
        input.resolution.state === 'cancelled' &&
        (current?.body.kind === 'approval' || current?.body.kind === 'question') &&
        current.body.resolution.state === 'cancelled'
      ) {
        unchanged = {
          itemId: current.itemId,
          revision: current.revision,
          cursor: journalContextCursor(state)
        }
        return []
      }
      const pending = validateJournalPendingPrompt(current ?? undefined, state.sessionId, input)
      if (!pending.ok) {
        throw new AgentSessionRefusalError(pending.refusal)
      }
      const identity = parseAgentJournalItemKey(input.itemId)
      if (!identity) {
        throw new AgentSessionRefusalError(
          refuse(
            'agent_session_operation_invalid',
            { reason: 'requestMalformed' },
            `Item id ${input.itemId} is not a well-formed item key.`
          )
        )
      }
      return [
        journalItemRowBuilder(
          deps.state,
          identity,
          { ...pending.prompt, resolution: input.resolution },
          input.options
        )
      ]
    },
    receipt,
    (saved) => saved[0]
  )
  if (unchanged) {
    return unchanged
  }
  const row = rows[0]
  if (!row || row.kind !== 'item') {
    throw new Error('prompt mutation did not write its item')
  }
  return {
    itemId: row.itemId,
    revision: row.revision,
    cursor: { epoch: row.epoch, sequence: row.seq }
  }
}
