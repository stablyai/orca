// The three lenses of the mobile Source Control hub. Kept as a pure module (no
// React/native imports) so tab parsing is unit-testable and the deep-link `tab`
// query param and the segmented control share one source of truth.

export type SourceControlHubTab = 'changes' | 'pr' | 'history'

export const SOURCE_CONTROL_HUB_TABS: readonly SourceControlHubTab[] = [
  'changes',
  'pr',
  'history'
] as const

export const SOURCE_CONTROL_HUB_TAB_LABELS: Record<SourceControlHubTab, string> = {
  changes: 'Changes',
  pr: 'Pull Request',
  history: 'Commits'
}

// Normalize a route param (possibly an array from expo-router, possibly unknown)
// to a valid tab, defaulting to 'changes'. Deep links that name a stale/invalid
// tab fall back rather than render a blank body.
export function parseSourceControlHubTab(
  value: string | string[] | undefined | null
): SourceControlHubTab {
  const first = Array.isArray(value) ? value[0] : value
  return SOURCE_CONTROL_HUB_TABS.includes(first as SourceControlHubTab)
    ? (first as SourceControlHubTab)
    : 'changes'
}
