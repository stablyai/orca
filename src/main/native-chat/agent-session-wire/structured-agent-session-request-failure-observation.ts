import { isAgentSessionContextClear } from '../../../shared/agent-session-context-clear'
import {
  agentJournalSubmissionKey,
  parseAgentJournalItemKey
} from '../../../shared/agent-session-journal-item-key'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { JournalRow } from '../agent-session-journal/journal-row-schema'
import type { JournalAppliedSubmission } from '../agent-session-journal/journal-reducer'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'
import type { ReleasedFailureRead } from './structured-agent-session-released-failure-read'
import type {
  StructuredAgentSessionRequestFailure,
  StructuredAgentSessionRequestFailures
} from './structured-agent-session-request-failures'

export type AccountedRequest = {
  kind: StructuredAgentSessionRequestFailure['kind']
  id: string
  mark: string
  edge: string
  created: number
}
export type CompletionMark = Pick<AccountedRequest, 'edge' | 'created'> & {
  disposition: 'observed' | 'historical' | 'deferred' | 'consumed' | 'reported'
}
export type Baseline = ReturnType<AgentSessionJournal['cursor']> & {
  sessionId: string
  journal: AgentSessionJournal
  floor: number
  marks: Map<string, CompletionMark>
  deferred?: { owner: object; request: AccountedRequest }
  releasedRead?: ReleasedFailureRead
  ended: StructuredAgentSessionHostSession['lastEndedChild']
}

export function observeRequestFailures(
  this: StructuredAgentSessionRequestFailures,
  sessionId: string,
  journal: AgentSessionJournal,
  rows?: readonly JournalRow[],
  applied?: readonly JournalAppliedSubmission[]
): void {
  const cursor = journal.cursor()
  let baseline = this['baselines'].get(sessionId)
  const items = new Set<string>()
  const touched = new Set<string>()
  const creations = new Map<string, number>()
  const submissions = new Set<string>()
  const appliedSubmissions = new Map(applied?.map((entry) => [entry.clientMessageId, entry]))
  let cleared = false
  for (const row of rows ?? []) {
    if (row.kind === 'tombstone' && row.stopEvent?.reason === 'user-stop' && row.stopEvent.turnId) {
      const target = journal.stoppedTurnItemId(row.stopEvent.turnId)
      if (target) {
        items.add(target)
      }
    }
    if (row.kind === 'dispatch' || row.kind === 'submission') {
      submissions.add(row.clientMessageId)
    }
    const mutations = row.kind === 'lifecycle-batch' ? row.mutations : [row]
    for (const mutation of mutations) {
      if (mutation.kind !== 'item' && mutation.kind !== 'tombstone') {
        continue
      }
      const id = journal.canonicalItemId(mutation.itemId)
      items.add(id)
      const identity = parseAgentJournalItemKey(id)
      if (identity?.provider === 'orca') {
        submissions.add(identity.clientMessageId)
      }
      touched.add(mutation.itemId)
      if (
        mutation.kind === 'item' &&
        journal.item(id)?.sequence === row.seq &&
        !creations.has(id)
      ) {
        creations.set(id, mutation.revision)
      }
      if (baseline && id !== mutation.itemId) {
        const prior = baseline.marks.get(`turn:${mutation.itemId}`)
        if (prior) {
          baseline.marks.set(`turn:${id}`, prior)
          baseline.marks.delete(`turn:${mutation.itemId}`)
        }
        if (baseline.deferred?.request.id === mutation.itemId) {
          baseline.deferred.request.id = id
        }
      }
      const scope = journal.item(id)?.turnScope
      if (scope?.kind === 'turn') {
        items.add(scope.turnItemId)
      }
      if (isAgentSessionContextClear(journal.itemBody(id) ?? undefined)) {
        cleared = true
      }
    }
  }
  const replaced =
    !rows ||
    !baseline ||
    baseline.journal !== journal ||
    baseline.epoch !== cursor.epoch ||
    cursor.sequence < baseline.sequence
  const historical = replaced || cleared
  if (replaced) {
    baseline?.releasedRead?.cancel()
  } else if (baseline?.releasedRead?.retiring) {
    return
  }
  if (historical) {
    // Context clear retires marks, while captured reads still belong to the held journal.
    baseline = Object.assign(replaced ? {} : (baseline ?? {}), {
      ...cursor,
      sessionId,
      journal,
      floor: journal.context.floor()?.sequence ?? 0,
      marks: new Map(),
      deferred: undefined,
      ended: this['deps'].sessions.get(sessionId)?.lastEndedChild
    })
    this['baselines'].set(sessionId, baseline)
    journal.visitItems((id) => items.add(id))
    for (const submission of journal.submissions()) {
      submissions.add(submission.clientMessageId)
    }
  }
  if (!baseline) {
    return
  }
  baseline.sequence = cursor.sequence
  for (const id of items) {
    const request = this['request'](baseline, 'turn', id)
    if (!request && (touched.has(id) || !journal.item(id))) {
      this['prune'](baseline, `turn:${id}`)
    }
    this['account'](sessionId, baseline, request, historical || (creations.get(id) ?? 1) > 1)
  }
  for (const id of submissions) {
    const request = this['request'](baseline, 'refused-send', id)
    if (!request) {
      this['prune'](baseline, `refused-send:${agentJournalSubmissionKey(id)}`)
    }
    const effect = appliedSubmissions.get(id)
    const live =
      request?.kind === 'refused-send' &&
      !replaced &&
      effect?.submittedSequence === request.created &&
      effect.sequence > baseline.floor
    this['account'](
      sessionId,
      baseline,
      request,
      !live && (historical || (creations.get(request?.id ?? '') ?? 1) > 1)
    )
  }
}
