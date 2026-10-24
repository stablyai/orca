import type { ClaudeStreamedTextCheckpoints } from './claude-streamed-text-contracts'
import type { createClaudeStreamedThinking } from './claude-streamed-thinking'
import type { ClaudeStreamedTextDelta } from './claude-streamed-block-identity'
import { claudeStreamingMessageBody } from './claude-structured-item-translation'
import {
  AGENT_SESSION_STREAMED_TEXT_MAX_BYTES,
  type AgentSessionDeltaWindow
} from '../native-chat/agent-session-wire/agent-session-delta-coalescer'
import { appendWithinUtf8ByteLimit } from '../native-chat/agent-session-wire/agent-session-streamed-text-bounds'
import { extendAgentSessionTextSource } from '../native-chat/agent-session-wire/agent-session-text-encoding'
import { withJournalText } from '../native-chat/agent-session-journal/journal-text-rows'
import type { ClaudeStreamedTextCheckpointDeps } from './claude-streamed-text-checkpoints'
import type {
  AgentJournalItemIdentity,
  AgentJournalItemBody,
  AgentJournalTurnScope
} from '../../shared/agent-session-journal-types'
import type {
  StructuredAgentSessionEventSink,
  StructuredAgentSessionItemAppendOptions
} from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { StructuredAgentSessionTransitionStep } from '../native-chat/agent-session-wire/structured-agent-session-transition'
import { estimateStructuredAgentSessionItemBytes } from '../native-chat/agent-session-wire/structured-agent-session-event-sink-estimate'
/** A terminal whole transfers ownership before its producer can forget the accumulated text. */
export function appendClaudeStreamedWhole(
  sink: StructuredAgentSessionEventSink,
  identity: AgentJournalItemIdentity,
  body: AgentJournalItemBody,
  options: StructuredAgentSessionItemAppendOptions
): boolean {
  if (!sink.tryAppendTransition) {
    const appendOptions = { ...options, lifecycle: true, retireText: true as const }
    const admission = sink.tryAppendItem?.(identity, body, appendOptions)
    if (admission && !admission.accepted) {
      return false
    }
    if (!admission) {
      sink.appendItem(identity, body, appendOptions)
    }
    sink.publish()
    return true
  }
  return appendClaudeTerminalSteps(sink, [claudeStreamedWholeStep(identity, body, options)])
}

export function claudeStreamedWholeStep(
  identity: AgentJournalItemIdentity,
  body: AgentJournalItemBody,
  options: StructuredAgentSessionItemAppendOptions
): StructuredAgentSessionTransitionStep {
  return {
    kind: 'item',
    reservedBytes: estimateStructuredAgentSessionItemBytes(identity, body, options),
    resolve: () => ({ identity, body }),
    options: { ...options, retireText: true }
  }
}

export function appendClaudeTerminalSteps(
  sink: StructuredAgentSessionEventSink,
  steps: readonly StructuredAgentSessionTransitionStep[]
): boolean {
  if (!steps.length) {
    return true
  }
  const transition = { steps, lifecycle: true, publish: true }
  const admission = sink.tryAppendTransition?.(transition)
  if (admission === undefined || admission.accepted) {
    return true
  }
  // The final provider frame cannot be requested again after pressure subsides.
  return (
    admission.reason === 'backpressure' &&
    sink.tryAppendTransition?.({ ...transition, finalTail: true }).accepted === true
  )
}

export function appendClaudePreparedSteps(
  sink: StructuredAgentSessionEventSink,
  steps: readonly StructuredAgentSessionTransitionStep[]
): boolean {
  if (sink.tryAppendTransition) {
    return appendClaudeTerminalSteps(sink, steps)
  }
  for (const step of steps) {
    if (step.kind !== 'item') {
      return false
    }
    const journal = sink.journalItems?.()
    if (!journal) {
      return false
    }
    const resolved = step.resolve(journal)
    if (resolved) {
      sink.appendItem(resolved.identity, resolved.body, { ...step.options, lifecycle: true })
    }
  }
  sink.publish()
  return true
}

export function claudeStreamedTextStep(
  deps: Pick<ClaudeStreamedTextCheckpointDeps, 'prepareText' | 'source'>,
  identity: AgentJournalItemIdentity,
  window: AgentSessionDeltaWindow | null,
  held: string,
  body: AgentJournalItemBody,
  options: StructuredAgentSessionItemAppendOptions,
  finish: boolean
): StructuredAgentSessionTransitionStep {
  if (deps.prepareText) {
    const suffix = (window?.suffix ?? '') + held
    const measured = extendAgentSessionTextSource(
      extendAgentSessionTextSource(undefined, window?.suffix ?? '', window?.cuts),
      held
    )
    return deps.prepareText(
      identity,
      body,
      {
        ...window,
        baseLength: window?.baseLength ?? 0,
        suffix,
        cuts: measured.cuts,
        observedBytes:
          (window?.observedBytes ?? deps.source?.(identity)?.observedBytes ?? 0) +
          Buffer.byteLength(held, 'utf8'),
        ...(held &&
        (window?.bytes ?? deps.source?.(identity)?.bytes ?? 0) + Buffer.byteLength(held, 'utf8') >
          AGENT_SESSION_STREAMED_TEXT_MAX_BYTES
          ? { limit: AGENT_SESSION_STREAMED_TEXT_MAX_BYTES }
          : {})
      },
      {
        ...options,
        streamText: {
          operation: finish ? 'finish' : 'replace',
          field: 0,
          baseLength: 0,
          suffix
        }
      }
    )
  }
  const complete = window && !window.source ? window.text() : undefined
  const text =
    complete === undefined
      ? undefined
      : appendWithinUtf8ByteLimit(
          [complete],
          Buffer.byteLength(complete, 'utf8'),
          held,
          Buffer.byteLength(held, 'utf8'),
          AGENT_SESSION_STREAMED_TEXT_MAX_BYTES
        ).chunks.join('')
  if (text === undefined) {
    throw new Error('claude_streamed_source_missing')
  }
  const whole = withJournalText(body, 0, text)
  return {
    kind: 'item',
    reservedBytes: estimateStructuredAgentSessionItemBytes(identity, whole, options),
    options,
    resolve: () => ({ identity: identity, body: whole })
  }
}

export function finishClaudeStreamedWork(
  sink: StructuredAgentSessionEventSink,
  streamedText: ClaudeStreamedTextCheckpoints,
  streamedThinking: Pick<
    ReturnType<typeof createClaudeStreamedThinking>,
    'finishOpen' | 'prepareFinishOpen'
  >,
  turnScope: () => AgentJournalTurnScope,
  held: { delta: ClaudeStreamedTextDelta; thinking: boolean } | undefined,
  completedAt?: number,
  settlement?: StructuredAgentSessionTransitionStep
): boolean {
  if (!sink.tryAppendTransition) {
    return streamedText.finish({ completedAt }) && streamedThinking.finishOpen(completedAt)
  }
  const prose = streamedText.prepareFinish(
    undefined,
    held && !held.thinking ? held.delta : undefined
  )
  const thinking = streamedThinking.prepareFinishOpen(
    completedAt,
    held?.thinking ? held.delta : undefined
  )
  const steps = prose.map((block) =>
    block.step(claudeStreamingMessageBody(''), {
      ...block.options,
      turnScope: turnScope()
    })
  )
  if (
    !appendClaudePreparedSteps(sink, [
      ...steps,
      ...thinking.steps,
      ...(settlement ? [settlement] : [])
    ])
  ) {
    return false
  }
  for (const block of prose) {
    block.forget()
  }
  thinking.accept()
  return true
}
