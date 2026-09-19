import type Database from '../../sqlite/sync-database'
import type {
  AgentJournalCursor,
  AgentJournalItemBody
} from '../../../shared/agent-session-journal-types'
import { parseAgentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import { journalMaterializationIdentity } from './journal-materialization-identity'
import type { JournalReducerState } from './journal-reducer'
import { journalDispatchRowBuilder, journalItemRowBuilder } from './journal-row-builders'
import type { JournalRow } from './journal-row-schema'

import {
  MAX_JOURNAL_RETIREMENT_TARGETS,
  MAX_JOURNAL_RETIREMENT_CAPTURE_BYTES,
  type JournalRetirementItem,
  type JournalRetirementSubmission,
  type JournalRetirementCapture
} from '../../../shared/agent-session-retirement'
export {
  MAX_JOURNAL_RETIREMENT_TARGETS,
  MAX_JOURNAL_RETIREMENT_CAPTURE_BYTES
} from '../../../shared/agent-session-retirement'
export type {
  JournalRetirementItem,
  JournalRetirementSubmission,
  JournalRetirementCapture
} from '../../../shared/agent-session-retirement'
export type JournalRetirementCaptureResult =
  | { disposition: 'captured'; capture: JournalRetirementCapture }
  | { disposition: 'abandoned'; reason: 'unreadable' | 'quota' }
export type JournalRetirementRepairResult = { changed: boolean; cursor: AgentJournalCursor }

const SUPERSEDED = new Error('journal_retirement_target_superseded')

export class JournalRetirement {
  constructor(
    private readonly deps: {
      state: () => JournalReducerState
      database: () => { db: Database.Database }
      readOnly: () => boolean
      serialize: <T>(run: () => Promise<T>) => Promise<T>
      enqueue: (build: (seq: number, ts: number) => JournalRow) => Promise<JournalRow>
      cursor: () => AgentJournalCursor
    }
  ) {}

  capture(): Promise<JournalRetirementCaptureResult> {
    return this.deps
      .serialize<JournalRetirementCaptureResult>(async () => {
        if (this.deps.readOnly()) {
          return { disposition: 'abandoned', reason: 'unreadable' }
        }
        const state = this.deps.state()
        const items: JournalRetirementItem[] = []
        for (const item of state.items.values()) {
          if (!unfinished(item.body)) {
            continue
          }
          items.push({
            itemId: item.itemId,
            revision: item.revision,
            mutationSequence: state.itemMutationSequences.get(item.itemId) ?? item.sequence,
            aliases: [...state.aliases]
              .filter(([, id]) => id === item.itemId)
              .map(([itemId]) => ({
                itemId,
                mutationSequence: state.aliasMutationSequences.get(itemId) ?? 0
              }))
          })
          if (
            items.length > MAX_JOURNAL_RETIREMENT_TARGETS ||
            (items.at(-1)?.aliases.length ?? 0) > MAX_JOURNAL_RETIREMENT_TARGETS
          ) {
            return { disposition: 'abandoned', reason: 'quota' }
          }
        }
        const submissions: JournalRetirementSubmission[] = []
        for (const entry of state.submissions.values()) {
          if (
            entry.dispatchState !== 'pending' &&
            !(entry.dispatchState === 'unknown' && !entry.recovered)
          ) {
            continue
          }
          submissions.push({
            clientMessageId: entry.clientMessageId,
            mutationSequence: state.submissionMutationSequences.get(entry.clientMessageId) ?? 0
          })
          if (items.length + submissions.length > MAX_JOURNAL_RETIREMENT_TARGETS) {
            return { disposition: 'abandoned', reason: 'quota' }
          }
        }
        const capture: JournalRetirementCapture = {
          sessionId: state.sessionId,
          epoch: state.epoch,
          incarnation: journalMaterializationIdentity(this.deps.database().db),
          throughSequence: state.lastSequence,
          items,
          submissions
        }
        return Buffer.byteLength(JSON.stringify(capture)) > MAX_JOURNAL_RETIREMENT_CAPTURE_BYTES
          ? { disposition: 'abandoned', reason: 'quota' }
          : { disposition: 'captured', capture }
      })
      .catch(() => ({ disposition: 'abandoned', reason: 'unreadable' }))
  }

  repairItem(input: {
    capture: JournalRetirementCapture
    target: JournalRetirementItem
    fence: number
    body: AgentJournalItemBody
  }): Promise<JournalRetirementRepairResult> {
    return this.write((seq, ts) => {
      const state = this.checkedState(input.capture)
      const target = input.target
      const item = state.items.get(target.itemId)
      if (
        !input.capture.items.some((entry) => JSON.stringify(entry) === JSON.stringify(target)) ||
        !item ||
        item.revision !== target.revision ||
        !unfinished(item.body) ||
        state.itemMutationSequences.get(target.itemId) !== target.mutationSequence ||
        state.aliases.has(target.itemId) ||
        target.aliases.some(
          (alias) =>
            state.aliases.get(alias.itemId) !== target.itemId ||
            state.aliasMutationSequences.get(alias.itemId) !== alias.mutationSequence
        ) ||
        [...state.aliases].some(
          ([alias, canonical]) =>
            canonical === target.itemId && !target.aliases.some((entry) => entry.itemId === alias)
        )
      ) {
        throw SUPERSEDED
      }
      const identity = parseAgentJournalItemKey(target.itemId)
      if (!identity) {
        throw SUPERSEDED
      }
      return journalItemRowBuilder(this.deps.state, identity, input.body, {
        fence: input.fence,
        recovered: true
      })(seq, ts)
    })
  }

  repairSubmission(input: {
    capture: JournalRetirementCapture
    target: JournalRetirementSubmission
    fence: number
    reason: string
  }): Promise<JournalRetirementRepairResult> {
    return this.write((seq, ts) => {
      const state = this.checkedState(input.capture)
      const target = input.target
      const submission = state.submissions.get(target.clientMessageId)
      if (
        !input.capture.submissions.some(
          (entry) =>
            entry.clientMessageId === target.clientMessageId &&
            entry.mutationSequence === target.mutationSequence
        ) ||
        !submission ||
        (submission.dispatchState !== 'pending' &&
          !(submission.dispatchState === 'unknown' && !submission.recovered)) ||
        state.submissionMutationSequences.get(target.clientMessageId) !== target.mutationSequence
      ) {
        throw SUPERSEDED
      }
      return journalDispatchRowBuilder(this.deps.state, {
        clientMessageId: target.clientMessageId,
        state: 'unknown',
        fence: input.fence,
        reason: input.reason,
        recovered: true
      })(seq, ts)
    })
  }

  private checkedState(capture: JournalRetirementCapture): JournalReducerState {
    const state = this.deps.state()
    if (
      state.sessionId !== capture.sessionId ||
      state.epoch !== capture.epoch ||
      journalMaterializationIdentity(this.deps.database().db) !== capture.incarnation
    ) {
      throw SUPERSEDED
    }
    return state
  }

  private write(
    build: (seq: number, ts: number) => JournalRow
  ): Promise<JournalRetirementRepairResult> {
    return this.deps
      .enqueue(build)
      .then((row) => ({
        changed: true,
        cursor: { epoch: row.epoch, sequence: row.seq }
      }))
      .catch((error: unknown) => {
        if (error !== SUPERSEDED) {
          throw error
        }
        return { changed: false, cursor: this.deps.cursor() }
      })
  }
}

function unfinished(body: AgentJournalItemBody): boolean {
  return (
    readAgentJournalTurn(body)?.state === 'running' ||
    (body.kind === 'tool-call' && body.state === 'running') ||
    ((body.kind === 'approval' || body.kind === 'question') && body.resolution.state === 'pending')
  )
}
