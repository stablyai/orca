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

export function parseSourceControlHubTab(
  value: string | string[] | undefined | null
): SourceControlHubTab {
  const first = Array.isArray(value) ? value[0] : value
  return SOURCE_CONTROL_HUB_TABS.includes(first as SourceControlHubTab)
    ? (first as SourceControlHubTab)
    : 'changes'
}
