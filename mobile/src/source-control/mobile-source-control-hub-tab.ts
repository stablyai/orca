import { translate } from '../i18n/mobile-i18n'

export type SourceControlHubTab = 'changes' | 'pr' | 'history'

export const SOURCE_CONTROL_HUB_TABS: readonly SourceControlHubTab[] = [
  'changes',
  'pr',
  'history'
] as const

export const SOURCE_CONTROL_HUB_TAB_LABELS: Record<SourceControlHubTab, string> = {
  get changes() {
    return translate('sourceControl.hubTab.changes', 'Changes')
  },
  get pr() {
    return translate('sourceControl.hubTab.pullRequest', 'Pull Request')
  },
  get history() {
    return translate('sourceControl.hubTab.commits', 'Commits')
  }
}

export function parseSourceControlHubTab(
  value: string | string[] | undefined | null
): SourceControlHubTab {
  const first = Array.isArray(value) ? value[0] : value
  return SOURCE_CONTROL_HUB_TABS.includes(first as SourceControlHubTab)
    ? (first as SourceControlHubTab)
    : 'changes'
}
