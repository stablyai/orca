// Released raw Project selection logic with current list presentation for mixed-page contracts.
import { useState } from 'react'
import { View } from 'react-native'
import { MobileSearchField } from '../components/MobileSearchField'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { hostScreenStyles as styles } from './host-screen-styles'
import { CheckRow } from './workspace-option-rows'
import { ListGroup } from '../components/list/ListGroup'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { WorkspaceOptionProps } from './workspace-option-controls'
export function ProjectsPage({ controller }: WorkspaceOptionProps) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const { settings, state } = controller
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const selected = state.view.filters.filterRepoIds
  const repos = controller.sectionsResult.uniqueRepos.filter(
    (repo) => !needle || repo.name.toLowerCase().includes(needle)
  )
  return (
    <View style={styles.optionGroup}>
      <View style={styles.optionSearch}>
        <MobileSearchField
          value={query}
          onChangeText={setQuery}
          placeholder={t(
            'hostScreen.workspaceOptionControls.searchProjectsPlaceholder',
            'Search projects…'
          )}
          accessibilityLabel={t(
            'hostScreen.workspaceOptionControls.searchProjects',
            'Search projects'
          )}
        />
      </View>
      <ListGroup>
        {[
          <CheckRow
            key="all"
            label={t('hostScreen.workspaceOptionControls.allProjects', 'All projects')}
            checked={selected.length === 0}
            onPress={() => settings.setFilter('filterRepoIds', [])}
          />,
          ...repos.map((repo) => (
            <CheckRow
              key={repo.key}
              label={repo.name}
              checked={selected.includes(repo.id)}
              onPress={() => settings.toggleRepoFilter(repo.id)}
              leading={<View style={[styles.filterRepoDot, { backgroundColor: repo.color }]} />}
            />
          ))
        ]}
      </ListGroup>
    </View>
  )
}
