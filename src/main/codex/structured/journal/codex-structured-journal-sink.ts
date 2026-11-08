import type {
  AgentJournalItemBody,
  AgentJournalRowAttribution
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalItemIdentity } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import type {
  StructuredAgentSessionItemAppendOptions,
  StructuredAgentSessionEventSink,
  StructuredAgentSessionSinkAdmission
} from '../../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import '../../../native-chat/agent-session-journal/writing/journal-row-builders'
import {
  journalLifecycleItemMutation,
  type JournalLifecycleIdentityMutationInput
} from '../../../native-chat/agent-session-journal/writing/journal-lifecycle-mutation'
import type { CodexPendingJournalPrompt } from './codex-structured-journal-settlement'
import type { CodexGoalRowChoice } from './codex-goal-journal-identity'
import type { CodexJournalTranslationAdmission } from './codex-structured-journal-contracts'
import { CODEX_JOURNAL_ADMITTED } from './codex-structured-journal-contracts'
import { CODEX_TURN_ROW_KEPT_BYTES } from './codex-structured-journal-translation-turns'

const ADMITTED: StructuredAgentSessionSinkAdmission = { accepted: true }

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
    // The writer revises turn rows at execution to preserve queued turn revisions.
    admission = sink.tryAppendTransition({
      steps: [
        {
          kind: 'settlement',
          settlementId,
          reservedBytes:
            Buffer.byteLength(JSON.stringify({ settlementId, mutations }), 'utf8') + 512,
          resolution: {
            kind: 'turn-revisions',
            mutations,
            keptBytes: CODEX_TURN_ROW_KEPT_BYTES
          }
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
  /** observedAt overrides append time for a delayed first write. */
  attribution: AgentJournalRowAttribution & { observedAt?: number }
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
  choice: CodexGoalRowChoice,
  attribution: AgentJournalRowAttribution
): CodexJournalTranslationAdmission {
  if (sink.tryAppendLifecycleTransition) {
    return criticalAdmission(
      sink.tryAppendLifecycleTransition(
        identitySizeBound,
        { kind: 'thread-goal', choice },
        attribution
      )
    )
  }
  const admission = appendCodexLifecycleItem(sink, identitySizeBound, choice.body, attribution)
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
