import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import { readAgentJournalTurn } from '../../shared/agent-session-turn-record'
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

function isTerminalTurnMutation(mutation: JournalLifecycleMutationInput): boolean {
  if (mutation.kind !== 'item') {
    return false
  }
  const turn = readAgentJournalTurn(mutation.body)
  return turn !== null && turn.state !== 'running'
}

export function appendCodexLifecycleMutations(
  sink: StructuredAgentSessionEventSink,
  settlementId: string,
  mutations: readonly JournalLifecycleMutationInput[],
  options: {
    ownerEndedClientMessageIds?: readonly string[]
    onCommitted?: () => void
    onAbandoned?: () => void
  } = {}
): StructuredAgentSessionSinkAdmission {
  const chunks = partitionJournalLifecycleMutations(settlementId, mutations)
  for (const { settlementId: id, mutations: chunk } of chunks) {
    const containsTerminalTurn = chunk.some(isTerminalTurnMutation)
    const ownerEndedClientMessageIds = containsTerminalTurn
      ? options.ownerEndedClientMessageIds
      : undefined
    const appendOptions = {
      lifecycle: true as const,
      ...(ownerEndedClientMessageIds ? { ownerEndedClientMessageIds } : {}),
      ...(containsTerminalTurn && options.onCommitted ? { onCommitted: options.onCommitted } : {}),
      ...(containsTerminalTurn && options.onAbandoned ? { onAbandoned: options.onAbandoned } : {})
    }
    let admission: StructuredAgentSessionSinkAdmission = ADMITTED
    if (sink.tryAppendLifecycleBatch) {
      admission = sink.tryAppendLifecycleBatch(id, chunk, appendOptions)
    } else if (sink.appendLifecycleBatch) {
      admission = sink.appendLifecycleBatch(id, chunk, appendOptions) ?? ADMITTED
    } else {
      for (const mutation of chunk) {
        if (mutation.kind === 'item') {
          if (sink.tryAppendItem) {
            admission = sink.tryAppendItem(mutation.identity, mutation.body, {
              lifecycle: true,
              ...(isTerminalTurnMutation(mutation) && ownerEndedClientMessageIds
                ? { ownerEndedClientMessageIds }
                : {})
            })
            if (!admission.accepted) {
              return admission
            }
          } else {
            sink.appendItem(mutation.identity, mutation.body, {
              lifecycle: true,
              ...(isTerminalTurnMutation(mutation) && ownerEndedClientMessageIds
                ? { ownerEndedClientMessageIds }
                : {})
            })
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
