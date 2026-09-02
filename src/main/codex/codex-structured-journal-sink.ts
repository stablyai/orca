import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import type {
  StructuredAgentSessionEventSink,
  StructuredAgentSessionJournalBlob,
  StructuredAgentSessionSinkAdmission
} from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { CodexPendingJournalPrompt } from './codex-structured-journal-settlement'
import type { CodexJournalTranslationAdmission } from './codex-structured-journal-contracts'
import { CODEX_JOURNAL_ADMITTED } from './codex-structured-journal-contracts'

function criticalAdmission(
  admission: StructuredAgentSessionSinkAdmission
): CodexJournalTranslationAdmission {
  return admission.accepted ? CODEX_JOURNAL_ADMITTED : admission
}

export function appendCodexLifecycleItem(
  sink: StructuredAgentSessionEventSink,
  identity: AgentJournalItemIdentity,
  body: AgentJournalItemBody,
  blobs: readonly StructuredAgentSessionJournalBlob[] = []
): CodexJournalTranslationAdmission {
  if (sink.tryAppendItem) {
    return criticalAdmission(sink.tryAppendItem(identity, body, blobs, { lifecycle: true }))
  }
  sink.appendItem(identity, body, blobs, { lifecycle: true })
  return CODEX_JOURNAL_ADMITTED
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
  items: readonly CodexPendingJournalPrompt[]
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
