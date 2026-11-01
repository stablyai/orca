import type { ConnectionPresentationModel } from './use-mobile-tasks-connection-presentation'
import { translate } from '../i18n/mobile-i18n'
import {
  BottomDrawer,
  View,
  Text,
  Pressable,
  Linking,
  ExternalLink,
  colors,
  Copy,
  TaskProviderLogo,
  ActivityIndicator,
  Plus,
  RefreshCw,
  X,
  GitBranch
} from './mobile-tasks-dependencies'
import { LIST_LEADING_INSET, ListGroup, ListRow } from '../components/list/ListGroup'
import { styles } from './mobile-tasks-legacy-styles'
import {
  projectRowStatusLabel,
  SHOW_MOBILE_DETAIL_LABEL_CHIPS,
  SHOW_MOBILE_PROJECT_METADATA_EDITORS,
  githubProjectOptionColor,
  canCreateWorkspaceFromProjectRow,
  projectRowType,
  TASK_SECONDARY_DRAWER_Z_INDEX
} from './mobile-tasks-legacy-foundation'
import { renderMobileTasksProjectFieldEditors } from './mobile-tasks-project-field-editors'
import {
  renderMobileTasksProjectLabelsEditor,
  renderMobileTasksProjectAssigneesEditor
} from './mobile-tasks-project-metadata-editors'
import { renderMobileTasksProjectLoadedDetail } from './mobile-tasks-project-detail-content'
import { pressedStyle } from '../theme/mobile-theme'

export function renderMobileTasksProjectMissingRepoDrawer(model: ConnectionPresentationModel) {
  const {
    copiedLinkKey,
    copyTextToClipboard,
    projectRepoNotInOrca,
    setProjectRepoNotInOrca,
    taskUiReady
  } = model
  return (
    <BottomDrawer
      visible={taskUiReady && projectRepoNotInOrca != null}
      onClose={() => {
        setProjectRepoNotInOrca(null)
      }}
      // Layer above the project detail rendered later in the shared host.
      zIndex={TASK_SECONDARY_DRAWER_Z_INDEX}
    >
      {projectRepoNotInOrca ? (
        <View>
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>
              {translate('tasks.projectDetailDrawer.repositoryNotInOrca', 'Repository not in Orca')}
            </Text>
            <Text style={styles.sheetSubtitle}>
              {translate(
                'tasks.projectDetailDrawer.addRepositoryFromDesktop',
                '{{repository}} is not added to Orca. Add this repository from the desktop app, then refresh mobile Tasks.',
                { repository: `${projectRepoNotInOrca.owner}/${projectRepoNotInOrca.repo}` }
              )}
            </Text>
          </View>

          <ListGroup separatorInset={LIST_LEADING_INSET}>
            {projectRepoNotInOrca.url ? (
              <ListRow
                key="open"
                title={translate('tasks.projectDetailDrawer.openInGitHub', 'Open in GitHub')}
                leading={<ExternalLink size={16} color={colors.textPrimary} />}
                onPress={() => {
                  if (projectRepoNotInOrca.url) {
                    void Linking.openURL(projectRepoNotInOrca.url)
                  }
                }}
              />
            ) : null}
            <ListRow
              key="copy"
              title={
                copiedLinkKey ===
                `project-repo:${projectRepoNotInOrca.owner}/${projectRepoNotInOrca.repo}`
                  ? translate('common.copied', 'Copied')
                  : translate('tasks.projectDetailDrawer.copyRepository', 'Copy repository')
              }
              leading={<Copy size={16} color={colors.textPrimary} />}
              onPress={() =>
                void copyTextToClipboard(
                  `project-repo:${projectRepoNotInOrca.owner}/${projectRepoNotInOrca.repo}`,
                  `${projectRepoNotInOrca.owner}/${projectRepoNotInOrca.repo}`
                )
              }
            />
          </ListGroup>
        </View>
      ) : null}
    </BottomDrawer>
  )
}

export function renderMobileTasksProjectDetailDrawer(model: ConnectionPresentationModel) {
  const {
    activeProjectLabel,
    copiedLinkKey,
    copyTaskLink,
    createWorkspaceFromProjectRow,
    creatingKey,
    mutateProjectRowIssueType,
    projectIssueTypes,
    projectIssueTypesError,
    projectIssueTypesLoading,
    projectMutating,
    projectRowDetail,
    projectRowHostedRepo,
    projectRowItem,
    setMergeMethodProjectRow,
    setPendingHostedStateChange,
    projectRowHandoff,
    taskUiReady
  } = model
  const projectNumber = projectRowItem?.content.number
  return (
    <BottomDrawer
      visible={taskUiReady && projectRowItem != null}
      {...projectRowHandoff.drawerProps}
    >
      {projectRowItem ? (
        <View>
          <View style={styles.sheetHeader}>
            <View style={styles.sheetTitleRow}>
              <TaskProviderLogo provider="github" size={16} color={colors.textPrimary} />
              <Text style={styles.sheetTitle} numberOfLines={2}>
                {projectRowItem.content.title}
              </Text>
            </View>
            <Text style={styles.sheetSubtitle}>
              {translate(
                'tasks.projectDetailDrawer.projectSubtitle',
                'GitHub Project · {{repository}}{{itemNumber}}',
                {
                  repository: projectRowItem.content.repository ?? activeProjectLabel,
                  itemNumber: projectNumber ? ` #${projectNumber}` : ''
                }
              )}
            </Text>
          </View>

          <View style={styles.detailGroup}>
            <View style={styles.detailMetaGrid}>
              <View style={styles.detailMetaItem}>
                <Text style={styles.detailMetaLabel}>
                  {translate('tasks.projectDetailDrawer.type', 'Type')}
                </Text>
                <Text style={styles.detailMetaValue}>
                  {projectRowItem.itemType === 'PULL_REQUEST'
                    ? translate('tasks.projectDetailDrawer.pullRequest', 'Pull request')
                    : projectRowItem.itemType === 'ISSUE'
                      ? translate('tasks.projectDetailDrawer.issue', 'Issue')
                      : projectRowItem.itemType === 'DRAFT_ISSUE'
                        ? translate('tasks.projectDetailDrawer.draftIssue', 'Draft issue')
                        : translate('tasks.projectDetailDrawer.projectItem', 'Project item')}
                </Text>
              </View>
              <View style={styles.detailMetaItem}>
                <Text style={styles.detailMetaLabel}>
                  {translate('tasks.projectDetailDrawer.status', 'Status')}
                </Text>
                <Text style={styles.detailMetaValue}>{projectRowStatusLabel(projectRowItem)}</Text>
              </View>
            </View>
            {SHOW_MOBILE_DETAIL_LABEL_CHIPS &&
            (projectRowDetail?.provider === 'github'
              ? projectRowDetail.labels
              : projectRowItem.content.labels.map((label) => label.name)
            ).length > 0 ? (
              <View style={styles.chipRow}>
                {(projectRowDetail?.provider === 'github'
                  ? projectRowDetail.labels
                  : projectRowItem.content.labels.map((label) => label.name)
                )
                  .slice(0, 6)
                  .map((label) => (
                    <View key={label} style={styles.detailChip}>
                      <Text style={styles.detailChipText}>{label}</Text>
                    </View>
                  ))}
              </View>
            ) : null}
            {SHOW_MOBILE_PROJECT_METADATA_EDITORS && projectRowItem.itemType === 'ISSUE' ? (
              <View style={styles.detailSection}>
                <View style={styles.detailSectionHeader}>
                  <Text style={styles.detailSectionTitle}>
                    {translate('tasks.projectDetailDrawer.issueType', 'Issue type')}
                  </Text>
                  <Text style={styles.detailSectionMeta}>
                    {projectRowItem.content.issueType?.name ??
                      translate('tasks.projectDetailDrawer.noType', 'No type')}
                  </Text>
                </View>
                {projectIssueTypesLoading ? (
                  <View style={styles.detailLoadingInline}>
                    <ActivityIndicator size="small" color={colors.textSecondary} />
                    <Text style={styles.detailMuted}>
                      {translate(
                        'tasks.projectDetailDrawer.loadingIssueTypes',
                        'Loading issue types...'
                      )}
                    </Text>
                  </View>
                ) : projectIssueTypesError ? (
                  <Text style={styles.detailError}>{projectIssueTypesError}</Text>
                ) : projectIssueTypes.length === 0 ? (
                  <Text style={styles.detailMuted}>
                    {translate(
                      'tasks.projectDetailDrawer.noIssueTypes',
                      'No issue types configured for this repository.'
                    )}
                  </Text>
                ) : (
                  <View style={styles.chipRow}>
                    {projectIssueTypes.map((issueType) => {
                      const selected = projectRowItem.content.issueType?.id === issueType.id
                      return (
                        <Pressable
                          key={issueType.id}
                          style={({ pressed }) => [
                            styles.detailChip,
                            selected ? styles.detailChipSelected : undefined,
                            pressed && pressedStyle
                          ]}
                          disabled={projectMutating || selected}
                          onPress={() => void mutateProjectRowIssueType(projectRowItem, issueType)}
                        >
                          <View style={styles.issueTypeChipContent}>
                            <View
                              style={[
                                styles.issueTypeDot,
                                { backgroundColor: githubProjectOptionColor(issueType.color) }
                              ]}
                            />
                            <Text style={styles.detailChipText}>{issueType.name}</Text>
                          </View>
                        </Pressable>
                      )
                    })}
                    {projectRowItem.content.issueType ? (
                      <Pressable
                        style={({ pressed }) => [styles.detailChip, pressed && pressedStyle]}
                        disabled={projectMutating}
                        onPress={() => void mutateProjectRowIssueType(projectRowItem, null)}
                      >
                        <Text style={styles.detailChipText}>
                          {translate('tasks.projectDetailDrawer.clearType', 'Clear type')}
                        </Text>
                      </Pressable>
                    ) : null}
                  </View>
                )}
              </View>
            ) : null}
            {renderMobileTasksProjectFieldEditors(model)}
            {renderMobileTasksProjectLabelsEditor(model)}
            {renderMobileTasksProjectAssigneesEditor(model)}
            {renderMobileTasksProjectLoadedDetail(model)}
          </View>

          <ListGroup separatorInset={LIST_LEADING_INSET}>
            {canCreateWorkspaceFromProjectRow(projectRowItem) ? (
              <ListRow
                key="create"
                title={translate('tasks.projectDetailDrawer.createWorkspace', 'Create Workspace')}
                leading={<Plus size={16} color={colors.textPrimary} />}
                disabled={creatingKey === `github-project:${projectRowItem.id}`}
                onPress={() =>
                  projectRowHandoff.closeThen(
                    () => void createWorkspaceFromProjectRow(projectRowItem)
                  )
                }
              />
            ) : (
              <Text key="create-note" style={styles.groupNote}>
                {translate(
                  'tasks.projectDetailDrawer.workspaceCreationRequirement',
                  'Workspaces can only be created from GitHub issues and pull requests.'
                )}
              </Text>
            )}
            {projectRowItem.content.url ? (
              <ListRow
                key="open"
                title={translate('tasks.projectDetailDrawer.openInGitHub', 'Open in GitHub')}
                leading={<ExternalLink size={16} color={colors.textPrimary} />}
                onPress={() => {
                  if (projectRowItem.content.url) {
                    void Linking.openURL(projectRowItem.content.url)
                  }
                }}
              />
            ) : null}
            {projectRowItem.content.url ? (
              <ListRow
                key="copy"
                title={
                  copiedLinkKey === `github-project:${projectRowItem.id}`
                    ? translate('common.copied', 'Copied')
                    : translate('tasks.projectDetailDrawer.copyGitHubLink', 'Copy GitHub link')
                }
                leading={<Copy size={16} color={colors.textPrimary} />}
                onPress={() =>
                  projectRowItem.content.url
                    ? void copyTaskLink(
                        `github-project:${projectRowItem.id}`,
                        projectRowItem.content.url
                      )
                    : undefined
                }
              />
            ) : null}
            {projectRowType(projectRowItem) &&
            projectRowItem.content.state !== 'MERGED' &&
            projectRowItem.itemType !== 'DRAFT_ISSUE' ? (
              <ListRow
                key="state"
                title={
                  projectRowItem.content.state === 'CLOSED'
                    ? translate('tasks.projectDetailDrawer.reopenItem', 'Reopen item')
                    : translate('tasks.projectDetailDrawer.closeItem', 'Close item')
                }
                leading={
                  projectRowItem.content.state === 'CLOSED' ? (
                    <RefreshCw size={16} color={colors.textPrimary} />
                  ) : (
                    <X size={16} color={colors.textPrimary} />
                  )
                }
                disabled={projectMutating}
                onPress={() =>
                  setPendingHostedStateChange({
                    source: 'project',
                    row: projectRowItem,
                    nextState: projectRowItem.content.state === 'CLOSED' ? 'open' : 'closed'
                  })
                }
              />
            ) : null}
            {projectRowItem.itemType === 'PULL_REQUEST' &&
            projectRowItem.content.state !== 'CLOSED' &&
            projectRowItem.content.state !== 'MERGED' ? (
              <ListRow
                key="merge"
                title={translate(
                  'tasks.projectDetailDrawer.mergePullRequest',
                  'Merge pull request'
                )}
                subtitle={
                  projectRowHostedRepo
                    ? undefined
                    : translate(
                        'tasks.projectDetailDrawer.mergeRepositoryRequirement',
                        'Merge requires this repository in Orca.'
                      )
                }
                leading={<GitBranch size={16} color={colors.textPrimary} />}
                disabled={projectMutating || !projectRowHostedRepo}
                onPress={() => setMergeMethodProjectRow(projectRowItem)}
              />
            ) : null}
          </ListGroup>
        </View>
      ) : null}
    </BottomDrawer>
  )
}
