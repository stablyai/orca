import {
  createNativeChatSessionOptionRecord,
  type NativeChatSessionOptionRecord
} from '../../../src/shared/native-chat-session-option-state'
import {
  decideConversationModelReport,
  type ConversationModelReport,
  type ConversationModelReportBaseline
} from '../../../src/shared/terminal-conversation-model-report'

// Why: per-tab records survive chat↔terminal flips and remounts, like desktop's
// scope cache. Bounded so long sessions across many tabs can't grow unbounded.
const MOBILE_SESSION_OPTION_RECORD_CAP = 32
const recordsByScope = new Map<string, NativeChatSessionOptionRecord>()
// The reported model last applied and the field report last observed, per scope and conversation.
// Mobile cannot read the agent's screen, so a repeat of the same report is not new evidence.
export const appliedReportByScope = new Map<string, ConversationModelReportBaseline>()

/** Records a scope's model report; true when it is new evidence the picker should apply. */
export function takeReportedModel(scopeKey: string, report: ConversationModelReport): boolean {
  const decision = decideConversationModelReport(appliedReportByScope.get(scopeKey), report)
  appliedReportByScope.set(scopeKey, decision.baseline)
  return decision.apply
}

export function getScopedRecord(scopeKey: string, agent: string): NativeChatSessionOptionRecord {
  const existing = recordsByScope.get(scopeKey)
  const record =
    existing && existing.agent === agent ? existing : createNativeChatSessionOptionRecord(agent)
  if (record !== existing) {
    appliedReportByScope.delete(scopeKey)
  }
  // Why: delete-then-set on every read makes the touched scope most-recent, so
  // eviction only sheds the oldest UNTOUCHED tab. Insertion order alone would let
  // a long-lived active tab be the oldest key and lose its tracked model.
  recordsByScope.delete(scopeKey)
  recordsByScope.set(scopeKey, record)
  while (recordsByScope.size > MOBILE_SESSION_OPTION_RECORD_CAP) {
    const oldest = recordsByScope.keys().next().value
    if (oldest === undefined) {
      break
    }
    recordsByScope.delete(oldest)
    appliedReportByScope.delete(oldest)
  }
  return record
}

export function clearMobileSessionOptionRecordsForTests(): void {
  recordsByScope.clear()
  appliedReportByScope.clear()
}
