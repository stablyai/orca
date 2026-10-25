import {
  createNativeChatSessionOptionRecord,
  type NativeChatSessionOptionRecord
} from '../../../src/shared/native-chat-session-option-state'

// Bound per-tab records that outlive chat/terminal switches and remounts.
const MOBILE_SESSION_OPTION_RECORD_CAP = 32
const recordsByScope = new Map<string, NativeChatSessionOptionRecord>()
// Repeated hook model reports are not fresh evidence: mobile cannot inspect the agent screen.
export const appliedReportByScope = new Map<string, string>()

export function getScopedRecord(scopeKey: string, agent: string): NativeChatSessionOptionRecord {
  const existing = recordsByScope.get(scopeKey)
  const record =
    existing && existing.agent === agent ? existing : createNativeChatSessionOptionRecord(agent)
  if (record !== existing) {
    appliedReportByScope.delete(scopeKey)
  }
  // Refresh Map order on read so eviction cannot drop a long-lived active tab’s model.
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
