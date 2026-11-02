import { translate } from '../i18n/mobile-i18n'

export type SourceControlHubTab = 'changes' | 'pr'

// `history` predates the Commits screen; links carrying it open Commits over Changes.
export type SourceControlHubRouteTab = SourceControlHubTab | 'history'

export const SOURCE_CONTROL_HUB_TABS: readonly SourceControlHubTab[] = ['changes', 'pr'] as const

export const SOURCE_CONTROL_HUB_TAB_LABELS: Record<SourceControlHubTab, string> = {
  get changes() {
    return translate('sourceControl.hubTab.changes', 'Changes')
  },
  get pr() {
    return translate('sourceControl.hubTab.pullRequest', 'Pull request')
  }
}

export function parseSourceControlHubTab(
  value: string | string[] | undefined | null
): SourceControlHubRouteTab {
  const first = Array.isArray(value) ? value[0] : value
  return first === 'pr' || first === 'history' ? first : 'changes'
}
