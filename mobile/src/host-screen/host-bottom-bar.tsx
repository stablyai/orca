import { Plus, SlidersHorizontal } from 'lucide-react-native'
import { BottomSearchBar } from '../components/nav-bar/BottomSearchBar'
import type { Translate } from '../i18n/mobile-i18n'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { HostScreenController } from './use-host-screen-controller'

function workspaceOptionsAccessibilityLabel(t: Translate, count: number): string {
  if (count <= 0) {
    return t('hostScreen.hostBottomBar.workspaceOptions', 'Workspace options')
  }
  return count === 1
    ? t(
        'hostScreen.hostBottomBar.activeFilters_one',
        'Workspace options ({{count}} filter active)',
        {
          count
        }
      )
    : t(
        'hostScreen.hostBottomBar.activeFilters_other',
        'Workspace options ({{count}} filters active)',
        { count }
      )
}

// The workspace list's bar under the thumb: Workspace options, search and New workspace.
export function HostBottomBar({
  controller,
  onCoveredHeightChange
}: {
  controller: HostScreenController
  onCoveredHeightChange: (height: number) => void
}) {
  const t = useMobileTranslation()
  const { actions, activeFilterCount, connState, insets, state } = controller
  return (
    <BottomSearchBar
      value={state.search}
      onChangeText={state.setSearch}
      placeholder={t('hostScreen.hostBottomBar.searchWorkspaces', 'Search workspaces')}
      bottomInset={insets.bottom}
      leading={{
        icon: SlidersHorizontal,
        accessibilityLabel: workspaceOptionsAccessibilityLabel(t, activeFilterCount),
        onPress: () => state.setShowWorkspaceOptions(true),
        badge: activeFilterCount
      }}
      primary={{
        icon: Plus,
        accessibilityLabel: t('hostScreen.hostBottomBar.newWorkspace', 'New workspace'),
        onPress: actions.openNewWorktreeModal,
        disabled: connState !== 'connected'
      }}
      onCoveredHeightChange={onCoveredHeightChange}
    />
  )
}
