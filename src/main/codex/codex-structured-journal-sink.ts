import { codexLiveTextKey } from './codex-thread-item-identity'
import type {
  CodexItemStreamDeps,
  CodexItemStreamState
} from './codex-structured-item-stream-contracts'
import type { AgentSessionDeltaWindow } from '../native-chat/agent-session-wire/agent-session-delta-coalescer'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentJournalRowAttribution
} from '../../shared/agent-session-journal-types'
import { withJournalReasoningLifecycle } from '../native-chat/agent-session-journal/journal-reasoning-row'
import { codexStreamingJournalItem } from './codex-structured-item-translation'
import type {
  StructuredAgentSessionItemAppendOptions,
  StructuredAgentSessionEventSink,
  StructuredAgentSessionIdentityResolver,
  StructuredAgentSessionSinkAdmission
} from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import {
  journalLifecycleItemMutation,
  type JournalLifecycleIdentityMutationInput
} from '../native-chat/agent-session-journal/journal-row-builders'
import type { CodexPendingJournalPrompt } from './codex-structured-journal-settlement'
import {
  CODEX_JOURNAL_ADMITTED,
  type CodexJournalTranslationAdmission
} from './codex-structured-journal-contracts'
import { reviseCodexTurnRow } from './codex-structured-journal-translation-turns'

const ADMITTED: StructuredAgentSessionSinkAdmission = { accepted: true }

export function appendCodexRunningStream(
  sink: StructuredAgentSessionEventSink,
  state: CodexItemStreamState,
  text: string,
  options: StructuredAgentSessionItemAppendOptions
): boolean {
  const translated = codexStreamingJournalItem(state.item, text)
  return (
    !translated.body ||
    appendCodexItemAndPublish(
      sink,
      state.identity,
      withJournalReasoningLifecycle(translated.body, { state: 'running' }),
      options
    ).accepted
  )
}

export function appendCodexLifecycleMutations(
  sink: StructuredAgentSessionEventSink,
  settlementId: string,
  mutations: readonly JournalLifecycleIdentityMutationInput[]
): StructuredAgentSessionSinkAdmission {
  if (mutations.length === 0) {
    return ADMITTED
  }
  let admission: StructuredAgentSessionSinkAdmission = ADMITTED
  if (sink.tryAppendTransition) {
    // Resolve against the journal at execution time to preserve queued turn revisions.
    admission = sink.tryAppendTransition({
      steps: [
        {
          kind: 'settlement',
          settlementId,
          reservedBytes:
            Buffer.byteLength(JSON.stringify({ settlementId, mutations }), 'utf8') + 512,
          resolve: (journal) =>
            mutations.map((mutation) =>
              mutation.kind === 'item' && mutation.body.kind === 'turn'
                ? {
                    ...mutation,
                    body: reviseCodexTurnRow(journal, mutation.identity, mutation.body)
                  }
                : mutation
            )
        }
      ],
      lifecycle: true,
      // Publish below to coalesce with queued publications.
      publish: false
    })
  } else if (sink.tryAppendLifecycleBatch) {
    admission = sink.tryAppendLifecycleBatch(settlementId, mutations, { lifecycle: true })
  } else if (sink.appendLifecycleBatch) {
    admission = sink.appendLifecycleBatch(settlementId, mutations, { lifecycle: true }) ?? ADMITTED
  } else {
    for (const mutation of mutations) {
      if (mutation.kind === 'item') {
        const options = {
          lifecycle: true,
          ...mutation.linkage,
          turnScope: mutation.turnScope
        }
        if (sink.tryAppendItem) {
          admission = sink.tryAppendItem(mutation.identity, mutation.body, options)
        } else {
          sink.appendItem(mutation.identity, mutation.body, options)
        }
      } else if (sink.tryAppendTombstone) {
        admission = sink.tryAppendTombstone(mutation.identity, { lifecycle: true })
      } else {
        sink.appendTombstone(mutation.identity, { lifecycle: true })
      }
      if (!admission.accepted) {
        return admission
      }
    }
  }
  if (!admission.accepted) {
    return admission
  }
  return sink.tryPublish
    ? sink.tryPublish({ lifecycle: true })
    : (sink.publish({ lifecycle: true }), ADMITTED)
}

export function appendCodexItemAndPublish(
  sink: StructuredAgentSessionEventSink,
  identity: AgentJournalItemIdentity,
  body: AgentJournalItemBody,
  options: StructuredAgentSessionItemAppendOptions
): StructuredAgentSessionSinkAdmission {
  if (options.streamText && sink.tryAppendStreamedItem) {
    return sink.tryAppendStreamedItem(identity, body, options)
  }
  const admission = sink.tryAppendItem
    ? sink.tryAppendItem(identity, body, options)
    : (sink.appendItem(identity, body, options), ADMITTED)
  if (!admission.accepted) {
    return admission
  }
  return sink.tryPublish ? sink.tryPublish() : (sink.publish(), ADMITTED)
}

function criticalAdmission(
  admission: StructuredAgentSessionSinkAdmission
): StructuredAgentSessionSinkAdmission {
  return admission.accepted ? CODEX_JOURNAL_ADMITTED : admission
}

export function appendCodexLifecycleItem(
  sink: StructuredAgentSessionEventSink,
  identity: AgentJournalItemIdentity,
  body: AgentJournalItemBody,
  /** observedAt overrides append time for a delayed first write. */
  attribution: AgentJournalRowAttribution & { observedAt?: number }
): StructuredAgentSessionSinkAdmission {
  const options = { lifecycle: true, retireText: true as const, ...attribution }
  if (sink.tryAppendItem) {
    return criticalAdmission(sink.tryAppendItem(identity, body, options))
  }
  sink.appendItem(identity, body, options)
  return CODEX_JOURNAL_ADMITTED
}

export function appendCodexLifecycleTransition(
  sink: StructuredAgentSessionEventSink,
  identitySizeBound: AgentJournalItemIdentity,
  body: AgentJournalItemBody,
  resolveIdentity: StructuredAgentSessionIdentityResolver,
  attribution: AgentJournalRowAttribution
): StructuredAgentSessionSinkAdmission {
  if (sink.tryAppendLifecycleTransition) {
    return criticalAdmission(
      sink.tryAppendLifecycleTransition(identitySizeBound, body, resolveIdentity, attribution)
    )
  }
  const admission = appendCodexLifecycleItem(sink, identitySizeBound, body, attribution)
  return admission.accepted ? publishCodexLifecycle(sink) : admission
}

export function publishCodexLifecycle(
  sink: StructuredAgentSessionEventSink
): StructuredAgentSessionSinkAdmission {
  if (sink.tryPublish) {
    return criticalAdmission(sink.tryPublish({ lifecycle: true }))
  }
  sink.publish({ lifecycle: true })
  return CODEX_JOURNAL_ADMITTED
}

export function admitCodexLifecycleItems(
  sink: StructuredAgentSessionEventSink,
  settlementId: string,
  items: readonly Pick<CodexPendingJournalPrompt, 'identity' | 'body'>[],
  attribution: AgentJournalRowAttribution
): CodexJournalTranslationAdmission {
  if (items.length === 0) {
    return { accepted: false, reason: 'untranslated' }
  }
  if (sink.tryAppendLifecycleBatch) {
    const admission = criticalAdmission(
      sink.tryAppendLifecycleBatch(
        settlementId,
        items.map((item) => journalLifecycleItemMutation(attribution, item.identity, item.body)),
        { lifecycle: true }
      )
    )
    return admission.accepted ? publishCodexLifecycle(sink) : admission
  }
  for (const item of items) {
    const admission = appendCodexLifecycleItem(sink, item.identity, item.body, attribution)
    if (!admission.accepted) {
      return admission
    }
  }
  return publishCodexLifecycle(sink)
}

export function appendCodexStreamWindow(
  deps: Pick<CodexItemStreamDeps, 'sink' | 'historyImport'>,
  producer: { threadId: string; turnId: string | null },
  state: CodexItemStreamState,
  text: string,
  attribution: AgentJournalRowAttribution,
  window?: AgentSessionDeltaWindow
): boolean {
  return appendCodexRunningStream(deps.sink, state, text, {
    ...attribution,
    ...(window
      ? {
          rawTextKey: codexLiveTextKey(
            producer.threadId,
            producer.turnId,
            state.item,
            deps.historyImport
          ),
          streamText: {
            ...window,
            operation: window.replace ? ('replace' as const) : ('append' as const),
            field: 0
          }
        }
      : {}),
    ...(state.startedAt === undefined ? {} : { observedAt: state.startedAt })
  })
}
