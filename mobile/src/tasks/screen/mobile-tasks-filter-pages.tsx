import type { ConnectionPresentationModel } from '../screen-state/use-mobile-tasks-connection-presentation'
import type { Translate } from '../../i18n/mobile-i18n'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useEffect } from 'react'
import { View } from 'react-native'
import { spacing } from '../../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../../theme/themed-styles'
import type { PickerOption } from '../../components/sheets/PickerModal'
import { SheetHeader } from '../../components/nav-bar/SheetHeader'
import { ListGroup, ListRow, SectionHeader } from '../../components/list/ListGroup'
import {
  linearDisplayOptions,
  linearGroupOptions,
  linearOrderOptions,
  linearViewOptions,
  sortOptions
} from '../task-list/mobile-tasks-options'
import {
  repositoryCount,
  getTaskRepoDetail
} from '../repositories/mobile-tasks-repository-presentation'
import { issueSourceSlug } from '../item-detail/mobile-tasks-reviewer-linear'
import {
  renderMobileTasksGitHubProjectPickerBody,
  selectMobileTasksGitHubProjectView
} from '../project-board/mobile-tasks-github-project-pickers'
import { selectMobileTasksLinearWorkspace } from './mobile-tasks-filter-selection'

export type MobileTasksFilterPageKey =
  | 'repos'
  | 'sort'
  | 'issueSource'
  | 'project'
  | 'projectView'
  | 'projectFields'
  | 'linearTeams'
  | 'linearWorkspace'
  | 'linearLayout'
  | 'linearGroup'
  | 'linearOrder'
  | 'linearDisplay'
  | 'jiraSite'

function pageTitle(page: MobileTasksFilterPageKey, t: Translate): string {
  switch (page) {
    case 'repos':
      return t('tasks.filterSheet.repositories', 'Repositories')
    case 'sort':
      return t('tasks.filterSheet.sort', 'Sort')
    case 'issueSource':
      return t('tasks.filterSheet.issueSource', 'Issue source')
    case 'project':
      return t('tasks.filterSheet.project', 'Project')
    case 'projectView':
      return t('tasks.filterSheet.view', 'View')
    case 'projectFields':
      return t('tasks.filterSheet.fields', 'Fields')
    case 'linearTeams':
      return t('tasks.filterSheet.teams', 'Teams')
    case 'linearWorkspace':
      return t('tasks.filterSheet.workspace', 'Workspace')
    case 'linearLayout':
      return t('tasks.filterSheet.layout', 'Layout')
    case 'linearGroup':
      return t('tasks.filterSheet.groupBy', 'Group by')
    case 'linearOrder':
      return t('tasks.filterSheet.orderBy', 'Order by')
    case 'linearDisplay':
      return t('tasks.filterSheet.showOnRows', 'Show on rows')
    case 'jiraSite':
      return t('tasks.filterSheet.site', 'Site')
  }
}

function ChoiceRows<T extends string>(props: {
  options: readonly PickerOption<T>[]
  selected: string
  onSelect: (value: T) => void
}) {
  const styles = useThemedStyles(stylesSheet)
  return (
    <ListGroup style={styles.group}>
      {props.options.map((option) => (
        <ListRow
          key={option.value}
          title={option.label}
          selected={option.value === props.selected}
          disabled={option.disabled}
          onPress={() => props.onSelect(option.value)}
        />
      ))}
    </ListGroup>
  )
}

type CheckRow = { key: string; title: string; subtitle?: string; checked: boolean }

function CheckRows(props: { rows: readonly CheckRow[]; onToggle: (key: string) => void }) {
  const styles = useThemedStyles(stylesSheet)
  return (
    <ListGroup style={styles.group}>
      {props.rows.map((row) => (
        <ListRow
          key={row.key}
          title={row.title}
          subtitle={row.subtitle}
          selected={row.checked}
          accessibilityRole="checkbox"
          onPress={() => props.onToggle(row.key)}
        />
      ))}
    </ListGroup>
  )
}

const ALL_KEY = ''

function ReposPage({ model }: { model: ConnectionPresentationModel }) {
  const t = useMobileTranslation()
  const { hostedRepos, effectiveRepoIds, repoHostLabels } = model
  const all = effectiveRepoIds.size === 0 || effectiveRepoIds.size === hostedRepos.length
  return (
    <CheckRows
      rows={[
        {
          key: ALL_KEY,
          title: t('tasks.providerPickers.allRepositories', 'All repositories'),
          subtitle: repositoryCount(hostedRepos.length),
          checked: all
        },
        ...hostedRepos.map((repo) => ({
          key: repo.id,
          title: repo.displayName,
          subtitle: getTaskRepoDetail(repo, repoHostLabels),
          checked: !all && effectiveRepoIds.has(repo.id)
        }))
      ]}
      onToggle={(key) => {
        if (key !== ALL_KEY) {
          model.toggleRepoSelection(key)
          return
        }
        const allSelection = new Set<string>()
        model.setSelectedRepoIds(allSelection)
        model.persistRepoSelection(allSelection, hostedRepos)
      }}
    />
  )
}

function IssueSourcePage({ model }: { model: ConnectionPresentationModel }) {
  const t = useMobileTranslation()
  return (
    <>
      {model.githubIssueSourceRows.map(({ repo, sources }, index) => (
        <View key={repo.id}>
          <SectionHeader title={repo.displayName} first={index === 0} />
          <ChoiceRows
            options={[
              {
                value: 'upstream' as const,
                label: t('tasks.providerPickers.upstreamSource', 'Upstream · {{slug}}', {
                  slug: issueSourceSlug(t, sources.upstreamCandidate)
                })
              },
              {
                value: 'origin' as const,
                label: t('tasks.providerPickers.originSource', 'Origin · {{slug}}', {
                  slug: issueSourceSlug(t, sources.prs)
                })
              }
            ]}
            selected={repo.issueSourcePreference === 'origin' ? 'origin' : 'upstream'}
            onSelect={(preference) => void model.setGitHubIssueSourcePreference(repo, preference)}
          />
        </View>
      ))}
    </>
  )
}

function LinearTeamsPage({ model }: { model: ConnectionPresentationModel }) {
  const t = useMobileTranslation()
  const { linearTeams, persistLinearTeamSelection, selectedLinearTeamIds } = model
  const count = linearTeams.length
  const all = selectedLinearTeamIds.size === 0 || selectedLinearTeamIds.size === count
  return (
    <CheckRows
      rows={[
        {
          key: ALL_KEY,
          title: t('tasks.filterPickers.allTeams', 'All teams'),
          subtitle:
            count === 1
              ? t('tasks.filterPickers.teams_one', '{{count}} team', { count })
              : t('tasks.filterPickers.teams_other', '{{count}} teams', { count }),
          checked: all
        },
        ...linearTeams.map((team) => ({
          key: team.id,
          title: team.name,
          subtitle: team.workspaceName ?? team.key,
          checked: !all && selectedLinearTeamIds.has(team.id)
        }))
      ]}
      onToggle={(key) => {
        const allTeams = new Set(linearTeams.map((team) => team.id))
        let next = key === ALL_KEY ? allTeams : new Set(all ? [] : selectedLinearTeamIds)
        if (key !== ALL_KEY) {
          if (next.has(key)) {
            next.delete(key)
          } else {
            next.add(key)
          }
          // Nothing ticked, or every team ticked, both mean all teams.
          if (next.size === 0 || next.size === count) {
            next = allTeams
          }
        }
        model.setSelectedLinearTeamIds(next)
        persistLinearTeamSelection(next, linearTeams)
      }}
    />
  )
}

function ProjectPage({ model }: { model: ConnectionPresentationModel }) {
  const styles = useThemedStyles(stylesSheet)
  const { loadGitHubProjects, setGithubProjectError, setShowFilterSheet } = model
  // The catalog loads only while a picker is open; this page is that picker inside the sheet.
  useEffect(() => {
    void loadGitHubProjects().catch((err: unknown) => {
      setGithubProjectError(err instanceof Error ? err.message : 'Failed to load projects')
    })
  }, [loadGitHubProjects, setGithubProjectError])
  return (
    <View style={styles.body}>
      {/* Picking commits the view; the sheet closes so a view choice it asks for shows. */}
      {renderMobileTasksGitHubProjectPickerBody(model, () => setShowFilterSheet(false))}
    </View>
  )
}

function toggleLinearDisplayProperty(model: ConnectionPresentationModel, key: string) {
  const property = linearDisplayOptions(model.t).find((option) => option.value === key)?.value
  if (!property) {
    return
  }
  if (property === 'team') {
    model.setLinearTeamPropertyTouched(true)
  }
  model.setLinearDisplayProperties((current) => {
    const next = new Set(current)
    if (next.has(property)) {
      next.delete(property)
    } else {
      next.add(property)
    }
    return next
  })
}

function FilterPageBody({
  model,
  page
}: {
  model: ConnectionPresentationModel
  page: MobileTasksFilterPageKey
}) {
  const t = useMobileTranslation()
  switch (page) {
    case 'repos':
      return <ReposPage model={model} />
    case 'sort':
      return (
        <ChoiceRows
          options={sortOptions(t)}
          selected={model.taskSort}
          onSelect={model.setTaskSort}
        />
      )
    case 'issueSource':
      return <IssueSourcePage model={model} />
    case 'project':
      return <ProjectPage model={model} />
    case 'projectView':
      return (
        <ChoiceRows
          options={model.githubProjectViewOptions}
          selected={model.activeGitHubProjectViewId ?? ''}
          onSelect={(viewId) => selectMobileTasksGitHubProjectView(model, viewId)}
        />
      )
    case 'projectFields':
      return (
        <CheckRows
          rows={model.githubProjectAvailableSummaryFields.map((field) => ({
            key: field.id,
            title: field.name,
            checked: !model.githubProjectHiddenFieldIds.has(field.id)
          }))}
          onToggle={model.toggleGitHubProjectFieldVisibility}
        />
      )
    case 'linearTeams':
      return <LinearTeamsPage model={model} />
    case 'linearWorkspace':
      return (
        <ChoiceRows
          options={model.linearWorkspaceOptions}
          selected={model.selectedLinearWorkspaceId ?? ''}
          onSelect={(workspaceId) => selectMobileTasksLinearWorkspace(model, workspaceId)}
        />
      )
    case 'linearLayout':
      return (
        <ChoiceRows
          options={linearViewOptions(t)}
          selected={model.linearViewMode}
          onSelect={model.setLinearViewMode}
        />
      )
    case 'linearGroup':
      return (
        <ChoiceRows
          options={linearGroupOptions(t)}
          selected={model.linearGroupBy}
          onSelect={model.setLinearGroupBy}
        />
      )
    case 'linearOrder':
      return (
        <ChoiceRows
          options={linearOrderOptions(t)}
          selected={model.linearOrderBy}
          onSelect={model.setLinearOrderBy}
        />
      )
    case 'linearDisplay':
      return (
        <CheckRows
          rows={linearDisplayOptions(t).map((property) => ({
            key: property.value,
            title: property.label,
            checked: model.effectiveLinearDisplayProperties.has(property.value)
          }))}
          onToggle={(key) => toggleLinearDisplayProperty(model, key)}
        />
      )
    case 'jiraSite':
      return (
        <ChoiceRows
          options={model.jiraSiteOptions}
          selected={model.jiraConnection.selection ?? ''}
          onSelect={(siteId) => {
            model.setJiraConnection((current) => ({ ...current, selection: siteId }))
            model.setItems([])
          }}
        />
      )
  }
}

/** One picker pushed inside the Filter sheet, with Back to the sheet and its Done. */
export function MobileTasksFilterPage({
  model,
  page,
  onBack,
  done
}: {
  model: ConnectionPresentationModel
  page: MobileTasksFilterPageKey
  onBack: () => void
  done: { label: string; onPress: () => void }
}) {
  const t = useMobileTranslation()
  return (
    <>
      <SheetHeader
        title={pageTitle(page, t)}
        onBack={{
          label: t('tasks.filterSheet.backToFilter', 'Back to Filter'),
          onPress: onBack
        }}
        trailing={done}
      />
      <FilterPageBody model={model} page={page} />
    </>
  )
}

const stylesSheet = themedStyleSheet(() => ({
  group: { marginBottom: spacing.md },
  body: { gap: spacing.sm }
}))
