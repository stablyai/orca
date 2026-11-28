import type { Translate } from '../../i18n/mobile-i18n'

export type SourceControlHubTab = 'changes' | 'pr'

// `history` predates the Commits screen; links carrying it open Commits over Changes.
export type SourceControlHubRouteTab = SourceControlHubTab | 'history'

export const SOURCE_CONTROL_HUB_TABS: readonly SourceControlHubTab[] = ['changes', 'pr'] as const

export function sourceControlHubTabLabel(tab: SourceControlHubTab, t: Translate): string {
  return tab === 'pr'
    ? t('sourceControl.hubTab.pullRequest', 'Pull request')
    : t('sourceControl.hubTab.changes', 'Changes')
}

export function parseSourceControlHubTab(
  value: string | string[] | undefined | null
): SourceControlHubRouteTab {
  const first = Array.isArray(value) ? value[0] : value
  return first === 'pr' || first === 'history' ? first : 'changes'
}
