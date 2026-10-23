import type { ConnectionPresentationModel } from './use-mobile-tasks-connection-presentation'
import type { PageChromeModel } from './use-mobile-tasks-page-chrome'
import {
  BottomDrawer,
  View,
  Text,
  Pressable,
  Linking,
  ExternalLink,
  StyleSheet,
  colors,
  Copy,
  ActivityIndicator,
  spacing,
  textStyles
} from './mobile-tasks-dependencies'
import { styles } from './mobile-tasks-legacy-styles'
import {
  projectRowStatusLabel,
  SHOW_MOBILE_DETAIL_LABEL_CHIPS,
  SHOW_MOBILE_PROJECT_METADATA_EDITORS,
  githubProjectOptionColor,
  canCreateWorkspaceFromProjectRow,
  TASK_SECONDARY_DRAWER_Z_INDEX
} from './mobile-tasks-legacy-foundation'
import { renderMobileTasksProjectFieldEditors } from './mobile-tasks-project-field-editors'
import {
  renderMobileTasksProjectLabelsEditor,
  renderMobileTasksProjectAssigneesEditor
} from './mobile-tasks-project-metadata-editors'
import { renderMobileTasksProjectLoadedDetail } from './mobile-tasks-project-detail-content'
import { MobileTasksDetailHeader } from './mobile-tasks-item-detail-drawer'
import {
  MobileTasksDetailActionBar,
  mobileTasksProjectMenuActions
} from './mobile-tasks-item-actions'
import { MobileTasksSheetError, sheetStyles } from './mobile-tasks-sheet-chrome'
import { PickerSheetTitle } from '../components/PickerModal'
import { Button } from '../components/ui/Button'
import { ListGroup } from '../components/ui/ListGroup'
import { ListRow } from '../components/ui/ListRow'
import { SectionHeader } from '../components/ui/SectionHeader'

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
      // Why: opens over the project detail, which renders after it in the shared host.
      zIndex={TASK_SECONDARY_DRAWER_Z_INDEX}
    >
      {projectRepoNotInOrca ? (
        <View>
          <PickerSheetTitle title="Repository not in Orca" />
          <Text style={missingRepoStyles.message}>
            {projectRepoNotInOrca.owner}/{projectRepoNotInOrca.repo} isn't added to Orca. Add it
            from Orca on your desktop, then refresh Tasks.
          </Text>
          <View style={sheetStyles.actions}>
            {projectRepoNotInOrca.url ? (
              <Button
                label="Open in GitHub"
                icon={ExternalLink}
                block
                onPress={() => {
                  if (projectRepoNotInOrca.url) {
                    Linking.openURL(projectRepoNotInOrca.url)
                  }
                }}
              />
            ) : null}
            <Button
              label={
                copiedLinkKey ===
                `project-repo:${projectRepoNotInOrca.owner}/${projectRepoNotInOrca.repo}`
                  ? 'Copied'
                  : 'Copy repository name'
              }
              icon={Copy}
              variant="plain"
              block
              onPress={() =>
                void copyTextToClipboard(
                  `project-repo:${projectRepoNotInOrca.owner}/${projectRepoNotInOrca.repo}`,
                  `${projectRepoNotInOrca.owner}/${projectRepoNotInOrca.repo}`
                )
              }
            />
          </View>
        </View>
      ) : null}
    </BottomDrawer>
  )
}

export function renderMobileTasksProjectDetailDrawer(model: PageChromeModel) {
  const {
    activeProjectLabel,
    copiedLinkKey,
    error,
    setDetailMenu,
    setError,
    copyTaskLink,
    createWorkspaceFromProjectRow,
    creatingKey,
    mutateProjectRowIssueType,
    projectIssueTypes,
    projectIssueTypesError,
    projectIssueTypesLoading,
    projectMutating,
    projectRowDetail,
    projectRowItem,
    projectRowHandoff,
    taskUiReady
  } = model
  return (
    <BottomDrawer
      visible={taskUiReady && projectRowItem != null}
      {...projectRowHandoff.drawerProps}
    >
      {projectRowItem ? (
        <View>
          <MobileTasksDetailHeader
            provider="github"
            kind={`GitHub project · ${activeProjectLabel}`}
            title={projectRowItem.content.title}
            meta={`${projectRowItem.content.repository ?? activeProjectLabel}${
              projectRowItem.content.number ? ` #${projectRowItem.content.number}` : ''
            } · ${projectRowStatusLabel(projectRowItem)}`}
          />
          <MobileTasksSheetError error={error} onDismiss={() => setError('')} />
          <MobileTasksDetailActionBar
            startLabel="Start workspace"
            starting={creatingKey === `github-project:${projectRowItem.id}`}
            onStart={
              canCreateWorkspaceFromProjectRow(projectRowItem)
                ? () =>
                    projectRowHandoff.closeThen(
                      () => void createWorkspaceFromProjectRow(projectRowItem)
                    )
                : null
            }
            startUnavailableReason={
              canCreateWorkspaceFromProjectRow(projectRowItem)
                ? undefined
                : 'Workspaces start from GitHub issues and pull requests, not drafts.'
            }
            url={projectRowItem.content.url}
            openLabel="Open in GitHub"
            copied={copiedLinkKey === `github-project:${projectRowItem.id}`}
            onCopy={
              projectRowItem.content.url
                ? () => {
                    if (projectRowItem.content.url) {
                      void copyTaskLink(
                        `github-project:${projectRowItem.id}`,
                        projectRowItem.content.url
                      )
                    }
                  }
                : null
            }
            menuCount={mobileTasksProjectMenuActions(model).length}
            onMenu={() => setDetailMenu('project')}
          />

          <View style={styles.detailGroup}>
            <View>
              <SectionHeader title="Details" first />
              <ListGroup style={sheetStyles.group}>
                <ListRow
                  key="type"
                  title="Type"
                  value={
                    projectRowItem.itemType === 'PULL_REQUEST'
                      ? 'Pull request'
                      : projectRowItem.itemType === 'ISSUE'
                        ? 'Issue'
                        : projectRowItem.itemType === 'DRAFT_ISSUE'
                          ? 'Draft issue'
                          : 'Project item'
                  }
                />
                <ListRow
                  key="status"
                  title="Status"
                  value={projectRowStatusLabel(projectRowItem)}
                />
              </ListGroup>
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
                  <Text style={styles.detailSectionTitle}>Issue type</Text>
                  <Text style={styles.detailSectionMeta}>
                    {projectRowItem.content.issueType?.name ?? 'No type'}
                  </Text>
                </View>
                {projectIssueTypesLoading ? (
                  <View style={styles.detailLoadingInline}>
                    <ActivityIndicator size="small" color={colors.textSecondary} />
                    <Text style={styles.detailMuted}>Loading issue types…</Text>
                  </View>
                ) : projectIssueTypesError ? (
                  <Text style={styles.detailError}>{projectIssueTypesError}</Text>
                ) : projectIssueTypes.length === 0 ? (
                  <Text style={styles.detailMuted}>
                    No issue types configured for this repository.
                  </Text>
                ) : (
                  <View style={styles.chipRow}>
                    {projectIssueTypes.map((issueType) => {
                      const selected = projectRowItem.content.issueType?.id === issueType.id
                      return (
                        <Pressable
                          key={issueType.id}
                          style={[
                            styles.detailChip,
                            selected ? styles.detailChipSelected : undefined
                          ]}
                          disabled={projectMutating || selected}
                          onPress={() => void mutateProjectRowIssueType(projectRowItem, issueType)}
                        >
                          <View style={styles.issueTypeChipContent}>
                            <View
                              style={[
                                styles.issueTypeDot,
                                {
                                  backgroundColor: githubProjectOptionColor(issueType.color)
                                }
                              ]}
                            />
                            <Text style={styles.detailChipText}>{issueType.name}</Text>
                          </View>
                        </Pressable>
                      )
                    })}
                    {projectRowItem.content.issueType ? (
                      <Pressable
                        style={styles.detailChip}
                        disabled={projectMutating}
                        onPress={() => void mutateProjectRowIssueType(projectRowItem, null)}
                      >
                        <Text style={styles.detailChipText}>Clear type</Text>
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
        </View>
      ) : null}
    </BottomDrawer>
  )
}

const missingRepoStyles = StyleSheet.create({
  message: {
    ...textStyles.callout,
    color: colors.textSecondary,
    textAlign: 'center',
    paddingHorizontal: spacing.xl
  }
})
