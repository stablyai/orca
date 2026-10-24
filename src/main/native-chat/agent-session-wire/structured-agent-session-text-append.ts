import type { StructuredAgentSessionTransitionStep } from './structured-agent-session-transition'
import type { JournalTextAdmission } from '../agent-session-journal/journal-text-rows'
import {
  extendAgentSessionTextSource,
  measureAgentSessionText
} from './agent-session-text-encoding'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { agentJournalLinkageFields } from '../../../shared/agent-session-journal-producer'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../../shared/agent-session-journal-types'
import { journalTextField, withJournalText } from '../agent-session-journal/journal-text-rows'
import type {
  AgentSessionDeltaSource,
  AgentSessionDeltaWindow
} from './agent-session-delta-coalescer'
import type {
  StructuredAgentSessionEventSink,
  StructuredAgentSessionItemAppendOptions
} from './structured-agent-session-event-sink'
import { estimateStructuredAgentSessionItemBytes } from './structured-agent-session-event-sink-estimate'
import type { StructuredAgentSessionSinkQueue } from './structured-agent-session-event-sink-queue'
import { structuredAgentSessionJournalAppendOptions } from './structured-agent-session-journal-append-options'

export type StructuredAgentSessionTextSink = {
  prepareText?: (
    identity: AgentJournalItemIdentity,
    body: AgentJournalItemBody,
    window: Pick<
      AgentSessionDeltaWindow,
      'suffix' | 'baseLength' | 'cuts' | 'limit' | 'replace' | 'applied' | 'source'
    > & { text?: () => string; observedBytes?: number; truncated?: boolean },
    options: StructuredAgentSessionItemAppendOptions
  ) => Extract<StructuredAgentSessionTransitionStep, { kind: 'item' }>
  liveText?: (key: string) => AgentSessionDeltaSource | undefined
  liveTexts?: () => AgentSessionDeltaSource[]
  textSource?: (identity: AgentJournalItemIdentity) => AgentSessionDeltaSource | undefined
}

/** Pending measures follow admitted operations; committed policy belongs to the canonical body. */
export function createStructuredAgentSessionTextAppend(queue: StructuredAgentSessionSinkQueue) {
  const pending = new Map<
    string,
    { source: AgentSessionDeltaSource; signature: string; count: number }
  >()
  const rawPending = new Map<string, string>()
  let uncertainBytes = 0
  const hold = (bytes: number) => ({
    install: () => {
      uncertainBytes += bytes
    },
    release: () => {
      uncertainBytes -= bytes
    }
  })
  const textSource = (identity: AgentJournalItemIdentity): AgentSessionDeltaSource | undefined => {
    const key = agentJournalItemKey(identity)
    return pending.get(key)?.source ?? queue.journalItems()?.textSource(key)
  }
  const prepareText: NonNullable<StructuredAgentSessionEventSink['prepareText']> = (
    identity,
    body,
    window,
    options
  ) => {
    const key = agentJournalItemKey(identity)
    const current = queue.journalItems()?.item(key)
    const currentText = current ? journalTextField(current.body, 0) : null
    const source =
      textSource(identity) ??
      window.source ??
      (currentText === null ? undefined : measureAgentSessionText(currentText))
    const signatureOf = (
      value: AgentJournalItemBody,
      metadata: { turnScope?: StructuredAgentSessionItemAppendOptions['turnScope'] } & Parameters<
        typeof agentJournalLinkageFields
      >[0]
    ) =>
      JSON.stringify({
        body: withJournalText(value, 0, ''),
        linkage: agentJournalLinkageFields(metadata),
        turnScope: metadata.turnScope
      })
    const signature = signatureOf(body, options)
    const prior = pending.get(key)
    const metadataChanged =
      (prior?.signature ?? (current ? signatureOf(current.body, current) : signature)) !== signature
    const operation =
      options.streamText?.operation === 'finish'
        ? 'finish'
        : window.replace || metadataChanged || uncertainBytes || (current && !textSource(identity))
          ? source || uncertainBytes
            ? 'replace'
            : 'start'
          : source
            ? 'append'
            : 'start'
    const suffix = window.replace ? (window.text?.() ?? window.suffix) : window.suffix
    const next = extendAgentSessionTextSource(source, suffix, window.cuts)
    next.live = options.rawTextKey
      ? {
          key: options.rawTextKey,
          identity,
          body: withJournalText(body, 0, ''),
          options: {
            ...agentJournalLinkageFields(options),
            turnScope: options.turnScope,
            observedAt: options.observedAt
          }
        }
      : source?.live
    const streamText: JournalTextAdmission = {
      ...window,
      source: next,
      operation,
      field: 0,
      suffix
    }
    const reservedBytes =
      estimateStructuredAgentSessionItemBytes(identity, withJournalText(body, 0, ''), options) +
      (operation === 'append'
        ? Buffer.byteLength(JSON.stringify(suffix), 'utf8')
        : Math.max(
            next.encodedBytes,
            (queue.journalItems()?.textSource(key)?.encodedBytes ?? 0) +
              Buffer.byteLength(JSON.stringify(suffix), 'utf8')
          ) + uncertainBytes)
    const adopt = (actual: AgentSessionDeltaSource) => {
      const tail = pending.get(key)?.source
      if (tail && tail !== next) {
        tail.length += actual.length - next.length
        tail.bytes += actual.bytes - next.bytes
        tail.encodedBytes += actual.encodedBytes - next.encodedBytes
        tail.observedBytes += actual.observedBytes - next.observedBytes
        tail.truncated ||= actual.truncated
      }
      Object.assign(next, actual)
      streamText.applied?.(next)
    }
    return {
      kind: 'item',
      reservedBytes,
      resolve: (journal) => {
        const actual = journal.textSource(key)
        if (operation === 'append' && actual?.truncated) {
          adopt(actual)
          return null
        }
        return { identity, body }
      },
      options: {
        ...options,
        streamText,
        applied: () => {
          if (streamText.source) {
            adopt(streamText.source)
          }
          options.applied?.()
        }
      },
      install: () => {
        if (next.live) {
          rawPending.set(next.live.key, key)
        }
        pending.set(key, { source: next, signature, count: (pending.get(key)?.count ?? 0) + 1 })
      },
      release: () => {
        const entry = pending.get(key)
        if (entry && --entry.count === 0) {
          pending.delete(key)
          if (entry.source.live && rawPending.get(entry.source.live.key) === key) {
            rawPending.delete(entry.source.live.key)
          }
        }
      }
    }
  }
  const tryAppendStreamedItem: NonNullable<
    StructuredAgentSessionEventSink['tryAppendStreamedItem']
  > = (identity, body, options) => {
    if (!options.streamText) {
      throw new Error('journal_text_operation_missing')
    }
    const operation = prepareText(identity, body, options.streamText, options)
    return queue.submit(
      {
        bytes: operation.reservedBytes,
        install: operation.install,
        release: operation.release,
        run: async (bound) => {
          await bound.journal.appendResolvedItem(() => operation.resolve(bound.journal), {
            ...structuredAgentSessionJournalAppendOptions(bound.fence, operation.options),
            reservedBytes: operation.reservedBytes
          })
          bound.publish()
        }
      },
      options
    )
  }
  const liveText = (key: string) => {
    const pendingKey = rawPending.get(key)
    return (
      (pendingKey ? pending.get(pendingKey)?.source : undefined) ??
      queue.journalItems()?.textSourceByRaw(key)
    )
  }
  const liveTexts = () => [
    ...new Map([
      ...Array.from(
        queue.journalItems()?.textSources() ?? [],
        (source) => [source.itemId, source] as const
      ),
      ...Array.from(pending, ([key, entry]) => [key, entry.source] as const)
    ]).values()
  ]
  return { textSource, liveText, liveTexts, prepareText, tryAppendStreamedItem, hold }
}

export function appendStructuredAgentSessionTextWindow(
  sink: StructuredAgentSessionEventSink,
  identity: AgentJournalItemIdentity,
  body: AgentJournalItemBody,
  window: AgentSessionDeltaWindow,
  options: StructuredAgentSessionItemAppendOptions
): boolean {
  if (sink.tryAppendStreamedItem) {
    return sink.tryAppendStreamedItem(identity, body, {
      ...options,
      streamText: { ...window, operation: window.replace ? 'replace' : 'append', field: 0 }
    }).accepted
  }
  const whole = withJournalText(body, 0, window.text())
  const admission = sink.tryAppendItem?.(identity, whole, options)
  if (admission && !admission.accepted) {
    return false
  }
  if (!admission) {
    sink.appendItem(identity, whole, options)
  }
  sink.publish()
  return true
}
