import { createNativeChatSessionOptionRecord } from '../../../src/shared/native-chat-session-option-state'
import type { NativeChatSessionOptionRecord } from '../../../src/shared/native-chat-session-option-state'

// Why: per-tab records survive chat↔terminal flips and remounts, like desktop's
// scope cache. Bounded so long sessions across many tabs can't grow unbounded.
const MOBILE_SESSION_OPTION_RECORD_CAP = 32
const recordsByScope = new Map<string, NativeChatSessionOptionRecord>()
// The catalog model id last taken from a hook report, per scope. Mobile cannot
// read the agent's screen, so a repeat of the same report is not new evidence.
const appliedReportByScope = new Map<string, string>()

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

/** The model id last applied from an agent report for this scope, if any. */
export function getAppliedReportModelId(scopeKey: string): string | undefined {
  return appliedReportByScope.get(scopeKey)
}

export function setAppliedReportModelId(scopeKey: string, modelId: string): void {
  appliedReportByScope.set(scopeKey, modelId)
}

export function clearMobileSessionOptionRecordsForTests(): void {
  recordsByScope.clear()
  appliedReportByScope.clear()
}
