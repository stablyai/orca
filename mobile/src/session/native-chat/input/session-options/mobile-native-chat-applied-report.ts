import { setBoundedScopeCacheEntry } from '../../../../../../src/shared/native-chat/input/composer/native-chat-scope-cache'

// Kept across remounts: a repeated hook model is not fresh evidence, and reapplying it would revert a newer pick.
const appliedReportByScope = new Map<string, string>()

export function clearMobileNativeChatAppliedReport(scopeKey: string): void {
  appliedReportByScope.delete(scopeKey)
}

/** True when this report is new for the scope and should be applied. */
export function rememberMobileNativeChatAppliedReport(scopeKey: string, modelId: string): boolean {
  if (appliedReportByScope.get(scopeKey) === modelId) {
    return false
  }
  setBoundedScopeCacheEntry(appliedReportByScope, scopeKey, modelId)
  return true
}
