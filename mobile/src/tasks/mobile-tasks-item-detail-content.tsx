import type { ConnectionPresentationModel } from './use-mobile-tasks-connection-presentation'
import { translate } from '../i18n/mobile-i18n'
import { isBrokenCheck } from '../../../src/shared/pr-checks-fix-prompt'
import {
  View,
  ActivityIndicator,
  colors,
  Text,
  Pressable,
  Linking,
  ExternalLink,
  TextField
} from './mobile-tasks-dependencies'
import { styles, getGitLabPipelineStatusStyle } from './mobile-tasks-legacy-styles'
import {
  taskKindLabel,
  SHOW_MOBILE_DETAIL_LABEL_CHIPS,
  SHOW_MOBILE_DETAIL_REVIEW_PANELS,
  formatDurationSeconds,
  SHOW_MOBILE_LINEAR_DETAIL_TOOLS,
  discussionSummary
} from './mobile-tasks-legacy-foundation'
import {
  renderMobileTasksItemBodyEditor,
  renderMobileTasksItemReviewPanel,
  renderMobileTasksItemFiles
} from './mobile-tasks-item-review-sections'
import { renderMobileTasksItemFieldEditors } from './mobile-tasks-item-field-editors'
import { JiraDetailMeta } from '../components/JiraDetailMeta'

function pipelineJobsSummary(count: number): string {
  return count === 1
    ? translate('tasks.itemDetailContent.pipelineJobs_one', '{{count}} jobs', { count })
    : translate('tasks.itemDetailContent.pipelineJobs_other', '{{count}} jobs', { count })
}

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
    setLinearCommentDraft,
    setLinearSubIssueTitle
  } = model
  if (!actionItem) {
    return null
  }
  return detailLoading ? (
    <View style={styles.detailLoading}>
      <ActivityIndicator size="small" color={colors.textSecondary} />
    </View>
  ) : detailError ? (
    <Text style={styles.detailError}>{detailError}</Text>
  ) : detailPayload ? (
    <>
      <View style={styles.detailMetaGrid}>
        <View style={styles.detailMetaItem}>
          <Text style={styles.detailMetaLabel}>
            {translate('tasks.itemDetailContent.type', 'Type')}
          </Text>
          <Text style={styles.detailMetaValue}>{taskKindLabel(actionItem)}</Text>
        </View>
        <View style={styles.detailMetaItem}>
          <Text style={styles.detailMetaLabel}>
            {translate('tasks.itemDetailContent.status', 'Status')}
          </Text>
          <Text style={styles.detailMetaValue}>{actionItem.status}</Text>
        </View>
        {detailPayload.provider === 'linear' && detailPayload.assignee ? (
          <View style={styles.detailMetaItem}>
            <Text style={styles.detailMetaLabel}>
              {translate('tasks.itemDetailContent.assignee', 'Assignee')}
            </Text>
            <Text style={styles.detailMetaValue}>{detailPayload.assignee}</Text>
          </View>
        ) : null}
        {detailPayload.provider === 'linear' && detailPayload.project ? (
          <View style={styles.detailMetaItem}>
            <Text style={styles.detailMetaLabel}>
              {translate('tasks.itemDetailContent.project', 'Project')}
            </Text>
            <Text style={styles.detailMetaValue}>{detailPayload.project.name}</Text>
          </View>
        ) : null}
        {detailPayload.provider === 'jira' ? (
          <JiraDetailMeta
            assignee={detailPayload.assignee}
            priorityName={detailPayload.priorityName}
            projectName={detailPayload.projectName}
          />
        ) : null}
        {(detailPayload.provider === 'github' || detailPayload.provider === 'gitlab') &&
        detailPayload.assignees.length > 0 ? (
          <View style={styles.detailMetaItem}>
            <Text style={styles.detailMetaLabel}>
              {translate('tasks.itemDetailContent.assignees', 'Assignees')}
            </Text>
            <Text style={styles.detailMetaValue}>{detailPayload.assignees.join(', ')}</Text>
          </View>
        ) : null}
      </View>

      {SHOW_MOBILE_DETAIL_LABEL_CHIPS && detailPayload.labels.length > 0 ? (
        <View style={styles.chipRow}>
          {detailPayload.labels.map((label) => (
            <View key={label} style={styles.detailChip}>
              <Text style={styles.detailChipText}>{label}</Text>
            </View>
          ))}
        </View>
      ) : null}

      <View style={styles.detailSection}>
        <Text style={styles.detailSectionTitle}>
          {translate('tasks.itemDetailContent.description', 'Description')}
        </Text>
        {renderMobileTasksItemBodyEditor(model)}
      </View>

      {renderMobileTasksItemFieldEditors(model)}

      {renderMobileTasksItemReviewPanel(model)}

      {SHOW_MOBILE_DETAIL_REVIEW_PANELS &&
      detailPayload.provider === 'github' &&
      actionItem.provider === 'github' &&
      actionItem.source.type === 'pr' ? (
        <View style={styles.detailSection}>
          <View style={styles.detailSectionHeader}>
            <Text style={styles.detailSectionTitle}>
              {translate('tasks.itemDetailContent.checks', 'Checks')}
            </Text>
            <View style={styles.inlineActionRow}>
              <Pressable
                style={styles.inlineSaveButtonCompact}
                disabled={mutatingStatus}
                onPress={() => void refreshGitHubChecks(actionItem)}
              >
                <Text style={styles.inlineSaveText}>{translate('common.refresh', 'Refresh')}</Text>
              </Pressable>
              <Pressable
                style={styles.inlineSaveButtonCompact}
                disabled={mutatingStatus || !detailPayload.checks.some(isBrokenCheck)}
                onPress={() => void rerunGitHubChecks(actionItem, true)}
              >
                <Text style={styles.inlineSaveText}>
                  {translate('tasks.itemDetailContent.rerunFailed', 'Rerun failed')}
                </Text>
              </Pressable>
              <Pressable
                style={styles.inlineSaveButtonCompact}
                disabled={mutatingStatus || detailPayload.checks.length === 0}
                onPress={() => void rerunGitHubChecks(actionItem, false)}
              >
                <Text style={styles.inlineSaveText}>
                  {translate('tasks.itemDetailContent.rerunAll', 'Rerun all')}
                </Text>
              </Pressable>
            </View>
          </View>
          {detailPayload.checks.length === 0 ? (
            <Text style={styles.detailMuted}>
              {translate('tasks.itemDetailContent.noChecks', 'No checks found.')}
            </Text>
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
            <Text style={styles.detailSectionTitle}>
              {translate('tasks.itemDetailContent.pipeline', 'Pipeline')}
            </Text>
            <Text style={styles.detailSectionMeta}>
              {detailPayload.pipelineJobs.length
                ? pipelineJobsSummary(detailPayload.pipelineJobs.length)
                : translate('tasks.itemDetailContent.none', 'None')}
            </Text>
          </View>
          {detailPayload.pipelineJobs.length === 0 ? (
            <Text style={styles.detailMuted}>
              {translate('tasks.itemDetailContent.noPipelineRuns', 'No pipeline runs for this MR.')}
            </Text>
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
            <Text style={styles.detailSectionTitle}>
              {translate('tasks.itemDetailContent.subIssues', 'Sub-issues')}
            </Text>
            <Text style={styles.detailSectionMeta}>
              {detailPayload.children.length || translate('tasks.itemDetailContent.none', 'None')}
            </Text>
          </View>
          {detailPayload.children.length === 0 ? (
            <Text style={styles.detailMuted}>
              {translate('tasks.itemDetailContent.noSubIssues', 'No sub-issues.')}
            </Text>
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
                <Text style={styles.detailSectionMeta}>{translate('common.open', 'Open')}</Text>
              </Pressable>
            ))
          )}
          <TextField
            style={styles.stackedInput}
            value={linearSubIssueTitle}
            onChangeText={setLinearSubIssueTitle}
            placeholder={translate('tasks.itemDetailContent.subIssueTitle', 'Sub-issue title')}
          />
          <Pressable
            style={styles.inlineSaveButton}
            disabled={mutatingStatus || linearSubIssueTitle.trim().length === 0}
            onPress={() => void createLinearSubIssue(actionItem)}
          >
            <Text style={styles.inlineSaveText}>
              {translate('tasks.itemDetailContent.addSubIssue', 'Add sub-issue')}
            </Text>
          </Pressable>
        </View>
      ) : null}

      <View style={styles.detailSection}>
        <View style={styles.detailSectionHeader}>
          <Text style={styles.detailSectionTitle}>
            {translate('tasks.itemDetailContent.discussion', 'Discussion')}
          </Text>
          <Text style={styles.detailSectionMeta}>
            {discussionSummary(detailPayload.comments.length)}
          </Text>
        </View>
        {detailPayload.comments.length === 0 ? (
          <Text style={styles.detailMuted}>
            {translate('tasks.itemDetailContent.noComments', 'No comments.')}
          </Text>
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
