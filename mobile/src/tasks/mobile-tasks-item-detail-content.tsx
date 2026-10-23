import type { ConnectionPresentationModel } from './use-mobile-tasks-connection-presentation'
import {
  View,
  colors,
  Text,
  Pressable,
  Linking,
  ExternalLink,
  TextInput,
  StyleSheet,
  spacing,
  textStyles
} from './mobile-tasks-dependencies'
import { styles, getGitLabPipelineStatusStyle } from './mobile-tasks-legacy-styles'
import {
  taskKindLabel,
  SHOW_MOBILE_DETAIL_LABEL_CHIPS,
  SHOW_MOBILE_DETAIL_REVIEW_PANELS,
  isFailedGitHubCheck,
  formatDurationSeconds,
  SHOW_MOBILE_LINEAR_DETAIL_TOOLS
} from './mobile-tasks-legacy-foundation'
import {
  renderMobileTasksItemBodyEditor,
  renderMobileTasksItemReviewPanel,
  renderMobileTasksItemFiles
} from './mobile-tasks-item-review-sections'
import { renderMobileTasksItemFieldEditors } from './mobile-tasks-item-field-editors'
import { jiraDetailMetaRows } from '../components/JiraDetailMeta'
import { Banner } from '../components/ui/Banner'
import { ListGroup } from '../components/ui/ListGroup'
import { ListRow } from '../components/ui/ListRow'
import { SectionHeader } from '../components/ui/SectionHeader'
import { StateView } from '../components/ui/StateView'
import { sheetStyles } from './mobile-tasks-sheet-chrome'

export function renderMobileTasksItemDetailContent(model: ConnectionPresentationModel) {
  const {
    actionItem,
    addHostedItemComment,
    addLinearComment,
    createLinearSubIssue,
    detailCommentGroups,
    detailError,
    detailLoading,
    detailPayload,
    itemCommentDraft,
    linearCommentDraft,
    linearSubIssueTitle,
    mutatingStatus,
    openLinearSubIssue,
    refreshGitHubChecks,
    renderCommentComposer,
    renderDetailCommentGroup,
    rerunGitHubChecks,
    setItemCommentDraft,
    setDetailRefreshSeq,
    setLinearCommentDraft,
    setLinearSubIssueTitle
  } = model
  if (!actionItem) {
    return null
  }
  const metaRows: { label: string; value: string }[] = []
  if (detailPayload) {
    metaRows.push({ label: 'Type', value: taskKindLabel(actionItem) })
    metaRows.push({ label: 'Status', value: actionItem.status })
    if (detailPayload.provider === 'linear') {
      if (detailPayload.assignee) {
        metaRows.push({ label: 'Assignee', value: detailPayload.assignee })
      }
      if (detailPayload.project) {
        metaRows.push({ label: 'Project', value: detailPayload.project.name })
      }
    }
    if (detailPayload.provider === 'jira') {
      metaRows.push(
        ...jiraDetailMetaRows({
          assignee: detailPayload.assignee,
          priorityName: detailPayload.priorityName,
          projectName: detailPayload.projectName
        })
      )
    }
    if (
      (detailPayload.provider === 'github' || detailPayload.provider === 'gitlab') &&
      detailPayload.assignees.length > 0
    ) {
      metaRows.push({
        label: 'Assignees',
        value: detailPayload.assignees.join(', ')
      })
    }
  }
  return detailLoading ? (
    <View style={detailContentStyles.loading}>
      <StateView loading title="Loading details…" />
    </View>
  ) : detailError ? (
    <View style={detailContentStyles.errorBanner}>
      <Banner
        tone="error"
        title="Couldn't load details"
        message={detailError}
        action={{
          label: 'Try again',
          onPress: () => setDetailRefreshSeq((current) => current + 1)
        }}
      />
    </View>
  ) : detailPayload ? (
    <>
      <SectionHeader title="Details" first />
      <ListGroup style={sheetStyles.group}>
        {metaRows.map((row) => (
          <ListRow key={row.label} title={row.label} value={row.value} />
        ))}
      </ListGroup>

      {SHOW_MOBILE_DETAIL_LABEL_CHIPS && detailPayload.labels.length > 0 ? (
        <View style={styles.chipRow}>
          {detailPayload.labels.map((label) => (
            <View key={label} style={styles.detailChip}>
              <Text style={styles.detailChipText}>{label}</Text>
            </View>
          ))}
        </View>
      ) : null}

      <SectionHeader title="Description" />
      <View style={detailContentStyles.body}>{renderMobileTasksItemBodyEditor(model)}</View>

      {renderMobileTasksItemFieldEditors(model)}

      {renderMobileTasksItemReviewPanel(model)}

      {SHOW_MOBILE_DETAIL_REVIEW_PANELS &&
      detailPayload.provider === 'github' &&
      actionItem.provider === 'github' &&
      actionItem.source.type === 'pr' ? (
        <View style={styles.detailSection}>
          <View style={styles.detailSectionHeader}>
            <Text style={styles.detailSectionTitle}>Checks</Text>
            <View style={styles.inlineActionRow}>
              <Pressable
                style={styles.inlineSaveButtonCompact}
                disabled={mutatingStatus}
                onPress={() => void refreshGitHubChecks(actionItem)}
              >
                <Text style={styles.inlineSaveText}>Refresh</Text>
              </Pressable>
              <Pressable
                style={styles.inlineSaveButtonCompact}
                disabled={mutatingStatus || !detailPayload.checks.some(isFailedGitHubCheck)}
                onPress={() => void rerunGitHubChecks(actionItem, true)}
              >
                <Text style={styles.inlineSaveText}>Rerun failed</Text>
              </Pressable>
              <Pressable
                style={styles.inlineSaveButtonCompact}
                disabled={mutatingStatus || detailPayload.checks.length === 0}
                onPress={() => void rerunGitHubChecks(actionItem, false)}
              >
                <Text style={styles.inlineSaveText}>Rerun all</Text>
              </Pressable>
            </View>
          </View>
          {detailPayload.checks.length === 0 ? (
            <Text style={styles.detailMuted}>No checks found.</Text>
          ) : (
            detailPayload.checks.map((check) => (
              <Pressable
                key={`${check.name}:${check.status}:${check.url ?? ''}`}
                style={styles.fileActionRow}
                disabled={!check.url}
                onPress={() => {
                  if (check.url) {
                    void Linking.openURL(check.url)
                  }
                }}
              >
                <Text style={styles.detailLine} numberOfLines={2}>
                  {check.name} · {check.conclusion ?? check.status}
                </Text>
                {check.url ? <ExternalLink size={14} color={colors.textSecondary} /> : null}
              </Pressable>
            ))
          )}
        </View>
      ) : null}

      {renderMobileTasksItemFiles(model)}

      {SHOW_MOBILE_DETAIL_REVIEW_PANELS &&
      detailPayload.provider === 'gitlab' &&
      actionItem.provider === 'gitlab' &&
      actionItem.source.type === 'mr' ? (
        <View style={styles.detailSection}>
          <View style={styles.detailSectionHeader}>
            <Text style={styles.detailSectionTitle}>Pipeline</Text>
            <Text style={styles.detailSectionMeta}>
              {detailPayload.pipelineJobs.length
                ? `${detailPayload.pipelineJobs.length} jobs`
                : 'None'}
            </Text>
          </View>
          {detailPayload.pipelineJobs.length === 0 ? (
            <Text style={styles.detailMuted}>No pipeline runs for this MR.</Text>
          ) : (
            detailPayload.pipelineJobs.map((job) => {
              const duration = formatDurationSeconds(job.duration)
              return (
                <Pressable
                  key={`${job.id ?? job.stage}:${job.name}`}
                  style={styles.fileCard}
                  disabled={!job.webUrl}
                  onPress={() => {
                    if (job.webUrl) {
                      void Linking.openURL(job.webUrl)
                    }
                  }}
                >
                  <View style={styles.fileActionRow}>
                    <Text style={styles.detailLine} numberOfLines={2}>
                      {job.name}
                    </Text>
                    <View
                      style={[styles.pipelineStatusChip, getGitLabPipelineStatusStyle(job.status)]}
                    >
                      <Text style={styles.pipelineStatusText}>{job.status}</Text>
                    </View>
                  </View>
                  <Text style={styles.detailMuted}>
                    {[job.stage, duration].filter(Boolean).join(' · ')}
                  </Text>
                </Pressable>
              )
            })
          )}
        </View>
      ) : null}

      {SHOW_MOBILE_LINEAR_DETAIL_TOOLS &&
      detailPayload.provider === 'linear' &&
      actionItem.provider === 'linear' ? (
        <View style={styles.detailSection}>
          <View style={styles.detailSectionHeader}>
            <Text style={styles.detailSectionTitle}>Sub-issues</Text>
            <Text style={styles.detailSectionMeta}>{detailPayload.children.length || 'None'}</Text>
          </View>
          {detailPayload.children.length === 0 ? (
            <Text style={styles.detailMuted}>No sub-issues.</Text>
          ) : (
            detailPayload.children.map((child) => (
              <Pressable
                key={child.id}
                style={styles.fileActionRow}
                disabled={mutatingStatus}
                onPress={() => void openLinearSubIssue(child, actionItem.source.workspaceId)}
              >
                <Text style={styles.detailLine}>
                  {child.identifier} · {child.title}
                </Text>
                <Text style={styles.detailSectionMeta}>Open</Text>
              </Pressable>
            ))
          )}
          <TextInput
            style={[styles.input, styles.stackedInput]}
            value={linearSubIssueTitle}
            onChangeText={setLinearSubIssueTitle}
            placeholder="Sub-issue title"
            placeholderTextColor={colors.textMuted}
          />
          <Pressable
            style={styles.inlineSaveButton}
            disabled={mutatingStatus || linearSubIssueTitle.trim().length === 0}
            onPress={() => void createLinearSubIssue(actionItem)}
          >
            <Text style={styles.inlineSaveText}>Add sub-issue</Text>
          </Pressable>
        </View>
      ) : null}

      <SectionHeader title="Discussion" count={detailPayload.comments.length} />
      <View style={detailContentStyles.body}>
        {detailPayload.comments.length === 0 ? (
          <Text style={detailContentStyles.empty}>No comments yet.</Text>
        ) : (
          detailCommentGroups.map(renderDetailCommentGroup)
        )}
        {(detailPayload.provider === 'github' && actionItem.provider === 'github') ||
        (detailPayload.provider === 'gitlab' && actionItem.provider === 'gitlab')
          ? renderCommentComposer({
              value: itemCommentDraft,
              onChangeText: setItemCommentDraft,
              disabled: mutatingStatus,
              onSubmit: () => void addHostedItemComment(actionItem)
            })
          : null}
        {detailPayload.provider === 'linear' && actionItem.provider === 'linear'
          ? renderCommentComposer({
              value: linearCommentDraft,
              onChangeText: setLinearCommentDraft,
              disabled: mutatingStatus,
              onSubmit: () => void addLinearComment(actionItem)
            })
          : null}
      </View>
    </>
  ) : null
}

export const detailContentStyles = StyleSheet.create({
  loading: { minHeight: 160 },
  errorBanner: { marginHorizontal: -spacing.sm },
  // The sheet pads 12, so 20 more lines body text up with the section headers above it.
  body: { paddingHorizontal: spacing.lg + 4, gap: spacing.md },
  empty: { ...textStyles.callout, color: colors.textSecondary }
})
