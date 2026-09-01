import type {
  AgentLaunchNoticeCode,
  PersistedLaunchNoticeState
} from '../../../src/shared/agent-launch-contract'

// `id` (shared by every tab variant) keeps this from being a weak type, so the
// full tab union — including variants that never carry notices — still satisfies it.
type LaunchNoticeCarrier = { id: string; launchNotices?: PersistedLaunchNoticeState }

// Why: mirror a host-owned launch-notice dismissal into the local tab list so the
// banner clears immediately. Notices are per-launchToken and shared across a tab's
// split leaves, so every leaf with the token loses the code. Returns the original
// array unchanged when nothing matched, so callers keep referential stability and
// avoid a needless re-render (a rejected dismissal is restored by the next snapshot).
export function dropDismissedLaunchNotice<T extends LaunchNoticeCarrier>(
  tabs: readonly T[],
  launchToken: string,
  code: AgentLaunchNoticeCode
): readonly T[] {
  let changed = false
  const next = tabs.map((tab) => {
    if (tab.launchNotices?.launchToken !== launchToken) {
      return tab
    }
    const remaining = tab.launchNotices.notices.filter((notice) => notice.code !== code)
    if (remaining.length === tab.launchNotices.notices.length) {
      return tab
    }
    changed = true
    if (remaining.length > 0) {
      return { ...tab, launchNotices: { launchToken, notices: remaining } }
    }
    const { launchNotices: _dropped, ...rest } = tab
    return rest as T
  })
  return changed ? next : tabs
}
