import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import type {
  StructuredAgentSessionEventSink,
  StructuredAgentSessionLifecycleIdentityResolver,
  StructuredAgentSessionSinkAdmission
} from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { partitionJournalLifecycleMutations } from '../native-chat/agent-session-journal/journal-lifecycle-batch-partition'
import type { JournalLifecycleMutationInput } from '../native-chat/agent-session-journal/journal-row-builders'
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
          if (sink.tryAppendItem) {
            admission = sink.tryAppendItem(mutation.identity, mutation.body, { lifecycle: true })
            if (!admission.accepted) {
              return admission
            }
          } else {
            sink.appendItem(mutation.identity, mutation.body, { lifecycle: true })
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

function criticalAdmission(
  admission: StructuredAgentSessionSinkAdmission
): CodexJournalTranslationAdmission {
  return admission.accepted ? CODEX_JOURNAL_ADMITTED : admission
}

export function appendCodexLifecycleItem(
  sink: StructuredAgentSessionEventSink,
  identity: AgentJournalItemIdentity,
  body: AgentJournalItemBody
): CodexJournalTranslationAdmission {
  if (sink.tryAppendItem) {
    return criticalAdmission(sink.tryAppendItem(identity, body, { lifecycle: true }))
  }
  sink.appendItem(identity, body, { lifecycle: true })
  return CODEX_JOURNAL_ADMITTED
}

export function appendCodexLifecycleTransition(
  sink: StructuredAgentSessionEventSink,
  identitySizeBound: AgentJournalItemIdentity,
  body: AgentJournalItemBody,
  resolveIdentity: StructuredAgentSessionLifecycleIdentityResolver
): CodexJournalTranslationAdmission {
  if (sink.tryAppendLifecycleTransition) {
    return criticalAdmission(
      sink.tryAppendLifecycleTransition(identitySizeBound, body, resolveIdentity)
    )
  }
  const admission = appendCodexLifecycleItem(sink, identitySizeBound, body)
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

export function admitCodexLifecycleItems(
  sink: StructuredAgentSessionEventSink,
  settlementId: string,
  items: readonly Pick<CodexPendingJournalPrompt, 'identity' | 'body'>[]
): CodexJournalTranslationAdmission {
  if (items.length === 0) {
    return { accepted: false, reason: 'untranslated' }
  }
  if (sink.tryAppendLifecycleBatch) {
    const admission = criticalAdmission(
      sink.tryAppendLifecycleBatch(
        settlementId,
        items.map((item) => ({ kind: 'item' as const, identity: item.identity, body: item.body })),
        { lifecycle: true }
      )
    )
    return admission.accepted ? publishCodexLifecycle(sink) : admission
  }
  for (const item of items) {
    const admission = appendCodexLifecycleItem(sink, item.identity, item.body)
    if (!admission.accepted) {
      return admission
    }
  }
  return publishCodexLifecycle(sink)
}
