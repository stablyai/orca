import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentJournalRowAttribution
} from '../../shared/agent-session-journal-types'
import type {
  StructuredAgentSessionItemAppendOptions,
  StructuredAgentSessionEventSink,
  StructuredAgentSessionLifecycleIdentityResolver,
  StructuredAgentSessionSinkAdmission
} from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { partitionJournalLifecycleMutations } from '../native-chat/agent-session-journal/journal-lifecycle-batch-partition'
import {
  journalLifecycleItemMutation,
  type JournalLifecycleMutationInput
} from '../native-chat/agent-session-journal/journal-row-builders'
import type { CodexPendingJournalPrompt } from './codex-structured-journal-settlement'
import type { CodexJournalTranslationAdmission } from './codex-structured-journal-contracts'
import { CODEX_JOURNAL_ADMITTED } from './codex-structured-journal-contracts'

const ADMITTED: StructuredAgentSessionSinkAdmission = { accepted: true }

export function appendCodexLifecycleMutations(
  sink: StructuredAgentSessionEventSink,
  settlementId: string,
  mutations: readonly JournalLifecycleMutationInput[]
): StructuredAgentSessionSinkAdmission {
  const chunks = partitionJournalLifecycleMutations(settlementId, mutations)
  for (const { settlementId: id, mutations: chunk } of chunks) {
    let admission: StructuredAgentSessionSinkAdmission = ADMITTED
    if (sink.tryAppendLifecycleBatch) {
      admission = sink.tryAppendLifecycleBatch(id, chunk, { lifecycle: true })
    } else if (sink.appendLifecycleBatch) {
      admission = sink.appendLifecycleBatch(id, chunk, { lifecycle: true }) ?? ADMITTED
    } else {
      for (const mutation of chunk) {
        if (mutation.kind === 'item') {
          const options = {
            lifecycle: true,
            ...mutation.linkage,
            turnScope: mutation.turnScope
          }
          if (sink.tryAppendItem) {
            admission = sink.tryAppendItem(mutation.identity, mutation.body, options)
            if (!admission.accepted) {
              return admission
            }
          } else {
            sink.appendItem(mutation.identity, mutation.body, options)
          }
        } else {
          if (sink.tryAppendTombstone) {
            admission = sink.tryAppendTombstone(mutation.identity, { lifecycle: true })
            if (!admission.accepted) {
              return admission
            }
          } else {
            sink.appendTombstone(mutation.identity, { lifecycle: true })
          }
        }
      }
    }
    if (!admission.accepted) {
      return admission
    }
    const publishAdmission = sink.tryPublish
      ? sink.tryPublish({ lifecycle: true })
      : (sink.publish({ lifecycle: true }), ADMITTED)
    if (!publishAdmission.accepted) {
      return publishAdmission
    }
  }
  return ADMITTED
}

/** An ordinary (non-lifecycle) append, published once admitted. */
export function appendCodexItemAndPublish(
  sink: StructuredAgentSessionEventSink,
  identity: AgentJournalItemIdentity,
  body: AgentJournalItemBody,
  options: StructuredAgentSessionItemAppendOptions
): StructuredAgentSessionSinkAdmission {
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
): CodexJournalTranslationAdmission {
  return admission.accepted ? CODEX_JOURNAL_ADMITTED : admission
}

export function appendCodexLifecycleItem(
  sink: StructuredAgentSessionEventSink,
  identity: AgentJournalItemIdentity,
  body: AgentJournalItemBody,
  attribution: AgentJournalRowAttribution
): CodexJournalTranslationAdmission {
  const options = { lifecycle: true, ...attribution }
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
  resolveIdentity: StructuredAgentSessionLifecycleIdentityResolver,
  attribution: AgentJournalRowAttribution
): CodexJournalTranslationAdmission {
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
): CodexJournalTranslationAdmission {
  if (sink.tryPublish) {
    return criticalAdmission(sink.tryPublish({ lifecycle: true }))
  }
  sink.publish({ lifecycle: true })
  return CODEX_JOURNAL_ADMITTED
}

/** One producer's rows, admitted together. */
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
