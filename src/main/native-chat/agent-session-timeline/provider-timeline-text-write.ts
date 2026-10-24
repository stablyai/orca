import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody
} from '../../../shared/agent-session-journal-types'
import type {
  AgentSessionDeltaCoalescer,
  AgentSessionDeltaWindow
} from '../agent-session-wire/agent-session-delta-coalescer'
import { estimateStructuredAgentSessionItemBytes } from '../agent-session-wire/structured-agent-session-event-sink-estimate'
import type { StructuredAgentSessionTransitionJournal } from '../agent-session-wire/structured-agent-session-transition'
import type { ProviderTimelineResolvedWrite } from './provider-timeline-decision'
import type { ProviderTimelineStream } from './provider-timeline-text-streams'
import type { ProviderTimelinePlan, ProviderTimelineSink } from './provider-timeline-plan'
import { providerTimelineTurnRowState, turnOf } from './provider-timeline-rows'

export function planProviderTimelineText(
  sink: ProviderTimelineSink,
  coalescer: AgentSessionDeltaCoalescer,
  plan: ProviderTimelinePlan,
  stream: ProviderTimelineStream,
  text: string,
  window?: AgentSessionDeltaWindow,
  finish = false,
  authoritative = false
): void {
  if (authoritative) {
    const body = providerTimelineTextBody(stream, text)
    plan.item(
      {
        reservedBytes: estimateStructuredAgentSessionItemBytes(stream.row.identity, body),
        resolve: (journal) => resolveTimelineText(stream, body, journal),
        options: { ...stream.producer, turnScope: stream.scope, retireText: true }
      },
      true
    )
    plan.onAdmitted(() => coalescer.markFlushed(stream.id))
    return
  }
  if (sink.prepareText) {
    const captured = window ?? coalescer.window(stream.id)
    const source = sink.textSource?.(stream.row.identity)
    if (!stream.written && !captured?.hasText && !text.trim()) {
      return
    }
    const prepared = sink.prepareText(
      stream.row.identity,
      providerTimelineTextBody(stream, ''),
      captured ?? { suffix: '', baseLength: source?.length ?? 0, source },
      {
        ...stream.producer,
        turnScope: stream.scope,
        ...(finish
          ? {
              streamText: {
                operation: 'finish' as const,
                field: 0,
                suffix: '',
                baseLength: source?.length ?? 0
              }
            }
          : {})
      }
    )
    const resolve = prepared.resolve
    plan.text(
      stream.id,
      {
        ...prepared,
        resolve: (journal) => {
          if (!resolveTimelineText(stream, providerTimelineTextBody(stream, ''), journal)) {
            journal.retireText(stream.row.itemId)
            return null
          }
          return resolve(journal)
        }
      },
      finish
    )
    plan.onAdmitted(() => {
      stream.written = true
      coalescer.markFlushed(stream.id)
    })
    return
  }
  if (finish && !authoritative) {
    text = coalescer.snapshot(stream.id)?.text ?? text
  }
  const empty = window ? !window.hasText : text.trim().length === 0
  if (!stream.written && empty) {
    plan.onAdmitted(() => coalescer.markFlushed(stream.id))
    return
  }
  const body = providerTimelineTextBody(stream, text)
  plan.text(
    stream.id,
    {
      reservedBytes:
        estimateStructuredAgentSessionItemBytes(stream.row.identity, body) +
        (window ? Buffer.byteLength(window.suffix, 'utf8') : 0),
      resolve: (journal) => resolveTimelineText(stream, body, journal),
      options: {
        ...stream.producer,
        turnScope: stream.scope,
        ...(window
          ? {
              streamText: {
                ...window,
                operation: window.replace ? ('replace' as const) : ('append' as const),
                field: 0
              }
            }
          : {})
      }
    },
    finish
  )
  plan.onAdmitted(() => {
    stream.written = true
    coalescer.markFlushed(stream.id)
  })
}
function resolveTimelineText(
  stream: ProviderTimelineStream,
  body: AgentJournalItemBody,
  journal: StructuredAgentSessionTransitionJournal
): ProviderTimelineResolvedWrite | null {
  if (stream.stoppedIn !== null) {
    return null
  }
  const turn = providerTimelineStreamTurn(stream, journal)
  if (turn !== null && providerTimelineTurnRowState(journal, turn) === 'settled') {
    stream.stoppedIn = turn
    return null
  }
  return { identity: stream.row.identity, body }
}

export function providerTimelineStreamTurn(
  stream: ProviderTimelineStream,
  journal: StructuredAgentSessionTransitionJournal
): string | null {
  const held = journal.item(stream.row.itemId)
  return turnOf(held ? (held.turnScope ?? AGENT_JOURNAL_THREAD_SCOPE) : stream.scope)
}

function providerTimelineTextBody(
  stream: ProviderTimelineStream,
  text: string
): AgentJournalItemBody {
  return {
    kind: 'message',
    role: stream.channel === 'assistant' ? 'assistant' : 'reasoning',
    blocks: [{ type: 'text', text }]
  }
}
