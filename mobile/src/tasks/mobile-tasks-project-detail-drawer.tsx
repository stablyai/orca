import type { ConnectionPresentationModel } from './use-mobile-tasks-connection-presentation'
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
import { styles } from './mobile-tasks-legacy-styles'
import {
  projectRowStatusLabel,
  SHOW_MOBILE_DETAIL_LABEL_CHIPS,
  SHOW_MOBILE_PROJECT_METADATA_EDITORS,
  githubProjectOptionColor,
  canCreateWorkspaceFromProjectRow,
  projectRowType
} from './mobile-tasks-legacy-foundation'
import { renderMobileTasksProjectFieldEditors } from './mobile-tasks-project-field-editors'
import {
  renderMobileTasksProjectLabelsEditor,
  renderMobileTasksProjectAssigneesEditor
} from './mobile-tasks-project-metadata-editors'
import { renderMobileTasksProjectLoadedDetail } from './mobile-tasks-project-detail-content'

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
    >
      {projectRepoNotInOrca ? (
        <View>
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>Repository not in Orca</Text>
            <Text style={styles.sheetSubtitle}>
              {projectRepoNotInOrca.owner}/{projectRepoNotInOrca.repo} is not added to Orca. Add
              this repository from the desktop app, then refresh mobile Tasks.
            </Text>
          </View>

          <View style={styles.actionGroup}>
            {projectRepoNotInOrca.url ? (
              <Pressable
                style={styles.actionRow}
                onPress={() => {
                  if (projectRepoNotInOrca.url) {
                    void Linking.openURL(projectRepoNotInOrca.url)
                  }
                }}
              >
                <ExternalLink size={16} color={colors.textPrimary} />
                <Text style={styles.actionText}>Open in GitHub</Text>
              </Pressable>
            ) : null}
            {projectRepoNotInOrca.url ? <View style={styles.actionSeparator} /> : null}
            <Pressable
              style={styles.actionRow}
              onPress={() =>
                void copyTextToClipboard(
                  `project-repo:${projectRepoNotInOrca.owner}/${projectRepoNotInOrca.repo}`,
                  `${projectRepoNotInOrca.owner}/${projectRepoNotInOrca.repo}`
                )
              }
            >
              <Copy size={16} color={colors.textPrimary} />
              <Text style={styles.actionText}>
                {copiedLinkKey ===
                `project-repo:${projectRepoNotInOrca.owner}/${projectRepoNotInOrca.repo}`
                  ? 'Copied'
                  : 'Copy repository'}
              </Text>
            </Pressable>
          </View>
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
    setProjectRowItem,
    taskUiReady
  } = model
  return (
    <BottomDrawer
      visible={taskUiReady && projectRowItem != null}
      onClose={() => setProjectRowItem(null)}
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
              GitHub Project · {projectRowItem.content.repository ?? activeProjectLabel}
              {projectRowItem.content.number ? ` #${projectRowItem.content.number}` : ''}
            </Text>
          </View>

          <View style={styles.detailGroup}>
            <View style={styles.detailMetaGrid}>
              <View style={styles.detailMetaItem}>
                <Text style={styles.detailMetaLabel}>Type</Text>
                <Text style={styles.detailMetaValue}>
                  {projectRowItem.itemType === 'PULL_REQUEST'
                    ? 'Pull request'
                    : projectRowItem.itemType === 'ISSUE'
                      ? 'Issue'
                      : projectRowItem.itemType === 'DRAFT_ISSUE'
                        ? 'Draft issue'
                        : 'Project item'}
                </Text>
              </View>
              <View style={styles.detailMetaItem}>
                <Text style={styles.detailMetaLabel}>Status</Text>
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
                  <Text style={styles.detailSectionTitle}>Issue type</Text>
                  <Text style={styles.detailSectionMeta}>
                    {projectRowItem.content.issueType?.name ?? 'No type'}
                  </Text>
                </View>
                {projectIssueTypesLoading ? (
                  <View style={styles.detailLoadingInline}>
                    <ActivityIndicator size="small" color={colors.textSecondary} />
                    <Text style={styles.detailMuted}>Loading issue types...</Text>
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

          <View style={styles.actionGroup}>
            {canCreateWorkspaceFromProjectRow(projectRowItem) ? (
              <Pressable
                style={styles.actionRow}
                disabled={creatingKey === `github-project:${projectRowItem.id}`}
                onPress={() => void createWorkspaceFromProjectRow(projectRowItem)}
              >
                <Plus size={16} color={colors.textPrimary} />
                <Text style={styles.actionText}>Create Workspace</Text>
              </Pressable>
            ) : (
              <Text style={styles.emptyInlineText}>
                Workspaces can only be created from GitHub issues and pull requests.
              </Text>
            )}

            {projectRowItem.content.url ? (
              <>
                {canCreateWorkspaceFromProjectRow(projectRowItem) ? (
                  <View style={styles.actionSeparator} />
                ) : null}
                <Pressable
                  style={styles.actionRow}
                  onPress={() => {
                    if (projectRowItem.content.url) {
                      void Linking.openURL(projectRowItem.content.url)
                    }
                  }}
                >
                  <ExternalLink size={16} color={colors.textPrimary} />
                  <Text style={styles.actionText}>Open in GitHub</Text>
                </Pressable>
                <View style={styles.actionSeparator} />
                <Pressable
                  style={styles.actionRow}
                  onPress={() =>
                    projectRowItem.content.url
                      ? void copyTaskLink(
                          `github-project:${projectRowItem.id}`,
                          projectRowItem.content.url
                        )
                      : undefined
                  }
                >
                  <Copy size={16} color={colors.textPrimary} />
                  <Text style={styles.actionText}>
                    {copiedLinkKey === `github-project:${projectRowItem.id}`
                      ? 'Copied'
                      : 'Copy GitHub link'}
                  </Text>
                </Pressable>
              </>
            ) : null}
            {projectRowType(projectRowItem) &&
            projectRowItem.content.state !== 'MERGED' &&
            projectRowItem.itemType !== 'DRAFT_ISSUE' ? (
              <>
                <View style={styles.actionSeparator} />
                <Pressable
                  style={styles.actionRow}
                  disabled={projectMutating}
                  onPress={() => {
                    const nextState = projectRowItem.content.state === 'CLOSED' ? 'open' : 'closed'
                    if (projectRowItem.itemType === 'PULL_REQUEST') {
                      setPendingHostedStateChange({
                        source: 'project',
                        row: projectRowItem,
                        nextState
                      })
                      return
                    }
                    setPendingHostedStateChange({
                      source: 'project',
                      row: projectRowItem,
                      nextState
                    })
                  }}
                >
                  {projectRowItem.content.state === 'CLOSED' ? (
                    <RefreshCw size={16} color={colors.textPrimary} />
                  ) : (
                    <X size={16} color={colors.textPrimary} />
                  )}
                  <Text style={styles.actionText}>
                    {projectRowItem.content.state === 'CLOSED' ? 'Reopen item' : 'Close item'}
                  </Text>
                </Pressable>
              </>
            ) : null}
            {projectRowItem.itemType === 'PULL_REQUEST' &&
            projectRowItem.content.state !== 'CLOSED' &&
            projectRowItem.content.state !== 'MERGED' ? (
              <>
                <View style={styles.actionSeparator} />
                <Pressable
                  style={styles.actionRow}
                  disabled={projectMutating || !projectRowHostedRepo}
                  onPress={() => setMergeMethodProjectRow(projectRowItem)}
                >
                  <GitBranch size={16} color={colors.textPrimary} />
                  <Text style={styles.actionText}>Merge pull request</Text>
                </Pressable>
                {!projectRowHostedRepo ? (
                  <Text style={styles.emptyInlineText}>
                    Merge requires this repository in Orca.
                  </Text>
                ) : null}
              </>
            ) : null}
          </View>
        </View>
      ) : null}
    </BottomDrawer>
  )
}
