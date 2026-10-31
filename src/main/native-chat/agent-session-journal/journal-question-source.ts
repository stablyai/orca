import { isAgentSessionContextClear } from '../../../shared/agent-session-context-clear'
import { JournalSourceEchoes } from './journal-source-echoes'
import {
  agentJournalSubmissionKey,
  parseAgentJournalItemKey
} from '../../../shared/agent-session-journal-item-key'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import { namesAgentJournalProducer } from '../../../shared/agent-session-journal-producer'
import { questionDependency } from './journal-question-dependency'
import { applyJournalRow, createJournalReducerState } from './journal-reducer'
import { nextJournalItemRevision } from './journal-item-revision'
import { journalBatchMutationProducer } from './journal-render-item'
import { journalItemExecutionFence } from './journal-item-provenance'
import type { JournalRow } from './journal-row-schema'

export type JournalQuestionInput =
  | { kind: 'item'; item: AgentJournalRenderItem; unsent: boolean; fence?: number }
  | { kind: 'remove'; itemId: string; at: number | null; order: readonly [number, number] }

type SourceRow = { row: JournalRow; index: number }

/** A factual projection of admitted inputs; terminal decisions belong only to question ingest. */
export class JournalQuestionSource {
  readonly inputs: JournalQuestionInput[] = []
  readonly state: ReturnType<typeof createJournalReducerState>
  private readonly dependencies = new Map<string, string>()
  private readonly relevant = new Set<string>()
  private readonly echoes = new JournalSourceEchoes()
  private readonly retained = new Set<SourceRow>()
  private readonly foundations = new Map<string, Map<string, SourceRow>>()

  get rows(): JournalRow[] {
    return [...this.retained]
      .sort((a, b) => a.row.seq - b.row.seq || a.index - b.index)
      .map(({ row }) => row)
  }

  constructor(sessionId: string, epoch: string) {
    this.state = createJournalReducerState(sessionId, epoch, false)
    this.state.sourceIdentity = { echoes: this.echoes, submissions: new Map(), contextSequence: 0 }
  }

  canonicalItemId = (id: string): string => this.state.aliases.get(id) ?? id

  observe(row: JournalRow, index = 0): void {
    if (row.kind === 'lifecycle-batch' && row.mutations.length > 1) {
      row.mutations.forEach((mutation, at) => this.observe({ ...row, mutations: [mutation] }, at))
      return
    }
    const { replayRole: _role, ...input } = row
    const entry = { row: input, index }
    let replay: JournalRow = input
    let id: string
    if (input.kind === 'item' || input.kind === 'tombstone') {
      id = this.canonicalItemId(input.itemId)
      replay = { ...input, revision: nextJournalItemRevision(this.state, id) }
      if (replay.kind === 'tombstone') {
        // Operational retirement cannot erase the historical identity join used by source replay.
        delete replay.retireSubmission
      }
    } else if (input.kind === 'lifecycle-batch') {
      const mutation = input.mutations[0]
      id = this.canonicalItemId(mutation.itemId)
      replay = {
        ...input,
        mutations: [{ ...mutation, revision: nextJournalItemRevision(this.state, id) }]
      }
      // Split admitted mutations retain their real settlement identity, without replaying its receipt.
      this.state.appliedSettlementIds.delete(input.settlementId)
    } else if (input.kind === 'submission' || input.kind === 'dispatch') {
      id = agentJournalSubmissionKey(input.clientMessageId)
    } else {
      return
    }
    if (row.replayRole === 'source-only') {
      this.retained.add(entry)
    }
    const mutation =
      input.kind === 'item'
        ? input
        : input.kind === 'lifecycle-batch' && input.mutations[0].kind === 'item'
          ? input.mutations[0]
          : undefined
    if (mutation) {
      const foundation = this.foundations.get(id) ?? new Map<string, SourceRow>()
      this.foundations.set(id, foundation)
      // A later question revision can inherit its creation time/scope, producer and echo contract.
      if (!this.state.items.has(id)) {
        foundation.set('creation', entry)
      }
      const producer =
        input.kind === 'lifecycle-batch' ? journalBatchMutationProducer(input, mutation) : mutation
      if (namesAgentJournalProducer(producer)) {
        foundation.set('producer', entry)
      }
      if (!this.state.itemEchoes.has(mutation.itemId) && Object.hasOwn(mutation, 'echoOf')) {
        foundation.set('echo', entry)
      }
    }
    if (input.kind === 'submission') {
      this.state.sourceIdentity?.submissions.set(
        agentJournalSubmissionKey(input.clientMessageId),
        input.clientMessageId
      )
    }
    const priorRevision = this.state.items.get(id)?.revision
    const priorInterruption = this.state.questionInterruptions.get(id)
    applyJournalRow(this.state, replay)
    const interruption = this.state.questionInterruptions.get(this.canonicalItemId(id))
    if (interruption && interruption !== priorInterruption) {
      interruption.order = [input.seq, index]
    }
    const removal =
      input.kind === 'tombstone' ||
      (input.kind === 'lifecycle-batch' && input.mutations[0].kind === 'tombstone')
    if (removal) {
      this.retained.add(entry)
      this.foundations.delete(id)
      this.inputs.push({ kind: 'remove', itemId: id, at: input.ts, order: [input.seq, index] })
      this.dependencies.delete(id)
      this.relevant.delete(id)
      return
    }
    const item = this.state.items.get(this.canonicalItemId(id))
    if (!item) {
      return
    }
    if (isAgentSessionContextClear(item.body) && this.state.sourceIdentity) {
      this.state.sourceIdentity.contextSequence = Math.max(
        this.state.sourceIdentity.contextSequence,
        item.sequence
      )
    }
    const identity = parseAgentJournalItemKey(item.itemId)
    const clientId =
      this.state.sourceIdentity?.submissions.get(item.itemId) ??
      (identity?.provider === 'orca' ? identity.clientMessageId : undefined)
    const submission = clientId !== undefined ? this.state.submissions.get(clientId) : undefined
    // An echo can accept a real submission; retain its original submitted body and identity.
    const unsent = submission !== undefined && submission.dispatchState !== 'accepted'
    if (submission && (input.kind === 'submission' || input.kind === 'dispatch')) {
      this.echoes.add(submission)
    }
    const dependency = questionDependency(item)
    const meaningful = dependency !== 'true' && dependency !== 'false'
    const wasRelevant = this.relevant.has(item.itemId)
    if (meaningful) {
      this.relevant.add(item.itemId)
    } else {
      this.relevant.delete(item.itemId)
    }
    const value = JSON.stringify([dependency, unsent])
    const prior = this.dependencies.get(item.itemId)
    this.dependencies.set(item.itemId, value)
    const claimedEcho = item.itemId !== id || (priorRevision === 0 && item.revision > 0)
    if (
      ((meaningful || wasRelevant) && value !== prior) ||
      claimedEcho ||
      input.kind === 'submission' ||
      input.kind === 'dispatch'
    ) {
      this.retain(entry, id, item.itemId)
      this.inputs.push({
        kind: 'item',
        item: { ...item, sequence: input.seq, sequenceIndex: index },
        unsent,
        // Removal can delete the operational item but cannot change this admitted import provenance.
        fence: journalItemExecutionFence(this.state, item.itemId)
      })
    }
  }

  private retain(entry: SourceRow, ...ids: string[]): void {
    for (const id of ids) {
      for (const dependency of this.foundations.get(id)?.values() ?? []) {
        this.retained.add(dependency)
      }
      this.foundations.delete(id)
    }
    this.retained.add(entry)
  }
}
