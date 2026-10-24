import { AGENT_SESSION_STREAMED_TEXT_MAX_BYTES } from '../agent-session-wire/agent-session-delta-coalescer'
import {
  measureAgentSessionText,
  extendAgentSessionTextSource,
  truncateAgentSessionTextEncoding
} from '../agent-session-wire/agent-session-text-encoding'
import { isDeepStrictEqual } from 'node:util'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { agentJournalLinkageFields } from '../../../shared/agent-session-journal-producer'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../../shared/agent-session-journal-types'
import type { JournalReducerState } from './journal-reducer'
import { journalItemRowBuilder } from './journal-row-builders'
import type { JournalRow } from './journal-row-schema'
import type { JournalItemAppendOptions } from './journal-store-contracts'
import { journalTextField, withJournalText } from './journal-text-rows'

export function journalStreamedItemBuilder(
  state: () => JournalReducerState,
  identity: AgentJournalItemIdentity,
  body: AgentJournalItemBody,
  options: JournalItemAppendOptions
): (seq: number, ts: number) => JournalRow {
  return (seq, ts) => {
    const current = state()
    const admission = options.streamText
    let row: JournalRow
    if (!admission) {
      row = journalItemRowBuilder(state, identity, body, options)(seq, ts)
    } else {
      const itemId = agentJournalItemKey(identity)
      if (
        (admission.source?.epoch && admission.source.epoch !== current.epoch) ||
        (admission.source?.itemId && admission.source.itemId !== itemId)
      ) {
        throw new Error('journal_text_owner_invalidated')
      }
      const previous = current.items.get(itemId)
      const oldText = previous ? journalTextField(previous.body, admission.field) : null
      const policy = previous ? current.textPolicy.get(itemId) : undefined
      const suffix = policy?.truncated ? '' : admission.suffix
      const next = extendAgentSessionTextSource(
        policy ?? (oldText === null ? undefined : measureAgentSessionText(oldText)),
        suffix,
        suffix.length ? admission.cuts : undefined
      )
      if (admission.operation === 'append') {
        if (
          !previous ||
          oldText === null ||
          !admission.suffix.length ||
          options.recovered ||
          options.echoOf !== undefined ||
          (options.ownerFence ?? current.itemFences.get(itemId)) !==
            current.itemFences.get(itemId) ||
          (options.executionOwner !== undefined &&
            options.executionOwner !== current.itemExecutionOwners.get(itemId)) ||
          !isDeepStrictEqual(options.turnScope, previous.turnScope) ||
          !isDeepStrictEqual(
            agentJournalLinkageFields(options),
            agentJournalLinkageFields(previous)
          ) ||
          !isDeepStrictEqual(
            withJournalText(previous.body, admission.field, ''),
            withJournalText(body, admission.field, '')
          )
        ) {
          throw new Error('journal_text_append_source_mismatch')
        }
        row = {
          v: 5,
          kind: 'text-delta',
          epoch: current.epoch,
          seq,
          fence: options.fence,
          ts: options.observedAt ?? ts,
          itemId,
          field: admission.field,
          revision: previous.revision + 1,
          predecessor: previous.revision,
          baseLength: oldText.length,
          suffix: admission.suffix,
          ownerFence: current.itemFences.get(itemId),
          ...(options.executionOwner === undefined
            ? {}
            : { executionOwner: options.executionOwner }),
          turnScope: options.turnScope,
          ...agentJournalLinkageFields(options)
        }
      } else {
        if (
          admission.operation === 'start'
            ? previous !== undefined
            : previous !== undefined && oldText === null
        ) {
          throw new Error('journal_text_whole_source_mismatch')
        }
        const prefix = admission.operation === 'start' ? '' : (oldText ?? '')
        const limit = admission.limit ?? AGENT_SESSION_STREAMED_TEXT_MAX_BYTES
        const bounded =
          admission.limit !== undefined || next.bytes > limit
            ? truncateAgentSessionTextEncoding(
                prefix + suffix,
                next.cuts ?? { blocks: [], count: 0 },
                limit
              )
            : undefined
        const text = bounded ? bounded.chunks.join('') : prefix + suffix
        if (bounded) {
          Object.assign(next, measureAgentSessionText(text), {
            cuts: undefined,
            truncated: true
          })
        }
        row = {
          ...journalItemRowBuilder(
            state,
            identity,
            withJournalText(body, admission.field, text),
            options
          )(seq, ts),
          v: 5
        }
      }
      next.observedBytes = Math.max(next.observedBytes, admission.observedBytes ?? 0)
      next.truncated ||= admission.truncated === true
      next.live = admission.source?.live ?? policy?.live
      next.revision = row.revision
      next.epoch = row.epoch
      next.itemId = itemId
      admission.source = next
    }
    if (
      options.reservedBytes !== undefined &&
      Buffer.byteLength(JSON.stringify(row), 'utf8') > options.reservedBytes
    ) {
      throw new Error('journal_text_materialized_reservation_exceeded')
    }
    return row
  }
}
