import type { AgentJournalSnapshot } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { isRootAgentJournalItem } from '../../../../shared/agent-session/journal/agent-session-journal-producer'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import {
  readAgentJournalTurn,
  readAgentJournalTurnOutcome
} from '../../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import { structuredAgentTurnAnchors } from '../../../../shared/native-chat/transcript/turns/native-chat-turn-membership'
import type { PipelineV2Submission } from '../../../../shared/pipelines/v2/pipeline-v2-run-contracts'
import type { PipelineV2ResponseObservation } from '../../../../shared/pipelines/v2/pipeline-v2-response-observation'
import { pipelineV2Fingerprint } from '../../../../shared/pipelines/v2/pipeline-v2-fingerprint'
import { parsePipelineV2Result } from './pipeline-v2-result-parser'
import { PipelineV2StageUsage } from '../../../../shared/pipelines/v2/pipeline-v2-response-observation'

export type PipelineV2Response =
  | {
      state: 'pending' | 'unverifiable' | 'interrupted'
      observation?: PipelineV2ResponseObservation
    }
  | {
      state: 'completed'
      result: PipelineV2Submission
      observation?: PipelineV2ResponseObservation
    }

export function readPipelineV2Response(
  snapshot: AgentJournalSnapshot,
  messageId: string
): PipelineV2Response {
  const sends = snapshot.submissions.filter(
    (send) => send.clientMessageId === messageId || send.queuedMessageId === messageId
  )
  const accepted = sends.filter((send) => send.dispatchState === 'accepted')
  const observe = (
    category: PipelineV2ResponseObservation['category'],
    extra: Partial<PipelineV2ResponseObservation> = {}
  ): PipelineV2ResponseObservation => ({
    requestMessageId: messageId,
    clientMessageId: accepted[0]?.clientMessageId ?? sends[0]?.clientMessageId ?? messageId,
    category,
    ...extra
  })
  if (accepted.length !== 1) {
    if (sends.some((send) => send.dispatchState === 'unknown') || accepted.length > 1) {
      return { state: 'unverifiable', observation: observe('transport_unknown') }
    }
    return {
      state: sends.some((send) => send.dispatchState === 'rejected') ? 'interrupted' : 'pending',
      ...(sends.some((send) => send.dispatchState === 'rejected')
        ? {
            observation: observe('transport_unknown', {
              reason: sends.find((send) => send.dispatchState === 'rejected')?.reason?.slice(0, 500)
            })
          }
        : {})
    }
  }
  const opener = agentJournalSubmissionKey(accepted[0].clientMessageId)
  const input = snapshot.items.find((item) => item.itemId === opener)
  if (!input) {
    return { state: 'unverifiable', observation: observe('transport_unknown') }
  }
  const anchors = structuredAgentTurnAnchors(snapshot.items, snapshot.submissions)
  const turns = snapshot.items.filter(
    (item) =>
      isRootAgentJournalItem(item) &&
      readAgentJournalTurn(item.body) &&
      anchors.get(item.itemId) === opener
  )
  if (turns.length !== 1) {
    return { state: turns.length === 0 ? 'pending' : 'unverifiable' }
  }
  const owner = turns[0]
  const turn = readAgentJournalTurn(owner.body)!
  const durationMs =
    turn.durationMs ??
    (turn.startedAt !== undefined && turn.completedAt !== undefined
      ? Math.max(0, turn.completedAt - turn.startedAt)
      : null)
  const reported = PipelineV2StageUsage.shape.tokens.safeParse(turn.tokenAccounting?.tokens)
  const response = snapshot.items.findLast(
    (item) =>
      isRootAgentJournalItem(item) &&
      item.turnScope?.kind === 'turn' &&
      item.turnScope.turnItemId === owner.itemId &&
      item.body.kind === 'message' &&
      item.body.role === 'assistant'
  )
  const body = response?.body
  const text =
    body?.kind === 'message'
      ? body.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
      : undefined
  const pin = {
    turnItemId: owner.itemId,
    ...(response ? { responseItemId: response.itemId } : {}),
    ...(text !== undefined
      ? {
          rawResponse: text.slice(0, 12000),
          rawTruncated: text.length > 12000,
          rawDigest: pipelineV2Fingerprint(text)
        }
      : {}),
    usage: {
      durationMs,
      tokens: reported.success ? reported.data : null,
      usd: null,
      source: 'journal_turn' as const
    }
  }
  if (turn.state === 'running') {
    return { state: 'pending' }
  }
  if (turn.state === 'unverifiable') {
    return { state: 'unverifiable', observation: observe('transport_unknown', pin) }
  }
  const outcome = readAgentJournalTurnOutcome(turn)
  if (turn.state === 'interrupted' || (outcome && outcome !== 'success')) {
    const quota = snapshot.items.some(
      (item) =>
        isRootAgentJournalItem(item) &&
        item.turnScope?.kind === 'turn' &&
        item.turnScope.turnItemId === owner.itemId &&
        item.body.kind === 'status' &&
        item.body.failure?.kind === 'usageLimitReached'
    )
    return {
      state: 'interrupted',
      observation: observe(
        quota ? 'quota' : outcome === 'cancellation' ? 'cancellation' : 'transport_unknown',
        pin
      )
    }
  }
  if (outcome !== 'success' || turn.completedAt === undefined) {
    return { state: 'unverifiable', observation: observe('transport_unknown', pin) }
  }
  if (
    snapshot.items.some(
      (item) =>
        isRootAgentJournalItem(item) &&
        item.body.kind === 'message' &&
        item.body.role === 'user' &&
        item.sequence > input.sequence
    )
  ) {
    return { state: 'unverifiable', observation: observe('transport_unknown', pin) }
  }
  if (
    text === undefined ||
    !body ||
    body.kind !== 'message' ||
    body.blocks.some((block) => block.type !== 'text')
  ) {
    return {
      state: 'interrupted',
      observation: observe('malformed_result', {
        ...pin,
        reason: 'Final response must contain only text'
      })
    }
  }
  const raw = pin
  if (text.length > 12000) {
    return {
      state: 'interrupted',
      observation: observe('malformed_result', { ...raw, reason: 'pipeline_result_budget' })
    }
  }
  const parsed = parsePipelineV2Result(text)
  return parsed.success
    ? { state: 'completed', result: parsed.data, observation: observe('result', raw) }
    : {
        state: 'interrupted',
        observation: observe('malformed_result', { ...raw, validationErrors: parsed.errors })
      }
}
