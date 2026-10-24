import { codexLiveTextKey } from './codex-thread-item-identity'
import type {
  CodexItemStreamDeps,
  CodexStructuredItemStreamAdmission
} from './codex-structured-item-stream-contracts'
import type { CodexItemStreamRetention } from './codex-item-stream-retention'
import type { AgentSessionDeltaCoalescer } from '../native-chat/agent-session-wire/agent-session-delta-coalescer'
import { codexStructuredItemKey } from './codex-structured-item-stream-bounds'
import {
  codexStreamingJournalItem,
  type CodexThreadItem
} from './codex-structured-item-translation'
import { appendCodexLifecycleItem, publishCodexLifecycle } from './codex-structured-journal-sink'
import {
  endedJournalReasoning,
  withJournalReasoningLifecycle
} from '../native-chat/agent-session-journal/journal-reasoning-row'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { StructuredAgentSessionTransitionStep } from '../native-chat/agent-session-wire/structured-agent-session-transition'
import { interruptedCodexItemBody } from './codex-unfinished-item-body'

type CodexStreamFinishSelection = {
  threadId?: string
  turnId?: string | null
  at?: number
  item?: CodexThreadItem
  historyImport?: true
}

export function prepareCodexStreamFinishes(
  sink: StructuredAgentSessionEventSink,
  select: CodexStreamFinishSelection
): StructuredAgentSessionTransitionStep[] {
  if (!sink.prepareText) {
    return []
  }
  const selected = select.item
    ? sink.liveText?.(
        codexLiveTextKey(select.threadId!, select.turnId ?? null, select.item, select.historyImport)
      )
    : undefined
  const sources = select.item ? (selected ? [selected] : []) : (sink.liveTexts?.() ?? [])
  return sources.flatMap((source) => {
    const live = source.live
    if (!live) {
      return []
    }
    const [provider, , thread, turn] = JSON.parse(live.key)
    if (
      provider !== 'codex' ||
      (select.threadId !== undefined && select.threadId !== thread) ||
      (select.turnId !== undefined && select.turnId !== turn)
    ) {
      return []
    }
    const body = interruptedCodexItemBody(live.body, { at: select.at })
    return body
      ? [
          sink.prepareText!(
            live.identity,
            body,
            { suffix: '', baseLength: source.length, source },
            {
              ...live.options,
              lifecycle: true,
              streamText: { operation: 'finish', field: 0, baseLength: source.length, suffix: '' }
            }
          )
        ]
      : []
  })
}

export function finishCodexStreams(
  deps: CodexItemStreamDeps,
  states: CodexItemStreamRetention,
  producers: ReadonlyMap<string, { threadId: string; turnId: string | null }>,
  coalescer: Pick<AgentSessionDeltaCoalescer, 'snapshot'>,
  forget: (key: string) => void,
  select: CodexStreamFinishSelection
): CodexStructuredItemStreamAdmission {
  const { threadId, turnId, at, item } = select
  const selectedKey = item ? codexStructuredItemKey(threadId!, item.id) : ''
  const selectedProducer = item ? producers.get(selectedKey) : undefined
  const candidates = item
    ? selectedProducer
      ? [[selectedKey, selectedProducer] as const]
      : []
    : producers
  const release = () => {
    for (const [key, producer] of candidates) {
      const state = states.get(key)
      if (
        (state?.item.type === 'agentMessage' || state?.item.type === 'reasoning') &&
        (deps.sink.prepareText || state.startedAt === undefined) &&
        (threadId === undefined || threadId === producer.threadId) &&
        (turnId === undefined || turnId === producer.turnId) &&
        (item === undefined || (item.id === state.item.id && item.type === state.item.type))
      ) {
        forget(key)
      }
    }
  }
  let wrote = false
  const steps = prepareCodexStreamFinishes(deps.sink, select)
  if (steps.length && deps.sink.tryAppendTransition) {
    const admission = deps.sink.tryAppendTransition({ steps, lifecycle: true, publish: true })
    if (admission.accepted) {
      release()
    }
    return admission
  }
  if (!deps.sink.prepareText) {
    for (const [key, producer] of candidates) {
      const state = states.get(key)
      if (!state) {
        continue
      }
      if (
        state.startedAt !== undefined ||
        (threadId !== undefined && threadId !== producer.threadId) ||
        (turnId !== undefined && turnId !== producer.turnId) ||
        (item !== undefined && (item.id !== state.item.id || item.type !== state.item.type)) ||
        (state.item.type !== 'agentMessage' && state.item.type !== 'reasoning')
      ) {
        continue
      }
      const text =
        coalescer.snapshot(codexStructuredItemKey(producer.threadId, state.item.id))?.text ?? ''
      const body = codexStreamingJournalItem(state.item, text).body
      if (body) {
        const admission = appendCodexLifecycleItem(
          deps.sink,
          state.identity,
          withJournalReasoningLifecycle(body, endedJournalReasoning(at)),
          {
            ...deps.attributionFor(producer.threadId, producer.turnId),
            observedAt: state.startedAt
          }
        )
        wrote ||= admission.accepted
        if (!admission.accepted) {
          return admission
        }
      }
    }
  }
  const admission = wrote ? publishCodexLifecycle(deps.sink) : { accepted: true as const }
  if (admission.accepted) {
    release()
  }
  return admission
}

export function restoreCodexTextState(
  deps: CodexItemStreamDeps,
  threadId: string,
  turnId: string | null,
  itemId: string,
  type: string
) {
  const item = { type, id: itemId }
  const live = deps.sink.liveText?.(codexLiveTextKey(threadId, turnId, item, deps.historyImport))
  return {
    item,
    identity: live?.live?.identity ?? deps.identityFor(threadId, turnId, item),
    startedAt: live?.live?.options.observedAt
  }
}
