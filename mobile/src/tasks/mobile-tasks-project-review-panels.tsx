import type { ConnectionPresentationModel } from './use-mobile-tasks-connection-presentation'
import { translate } from '../i18n/mobile-i18n'
import { isBrokenCheck } from '../../../src/shared/pr-checks-fix-prompt'
import {
  SHOW_MOBILE_PROJECT_REVIEW_PANELS,
  getGitHubReviewSummary,
  getGitHubReviewerRows,
  splitReviewerList,
  projectRowType,
  GitHubPrFileDiff
} from './mobile-tasks-legacy-foundation'
import {
  View,
  Text,
  ActivityIndicator,
  colors,
  Pressable,
  Check,
  TextInput,
  Linking,
  ExternalLink
} from './mobile-tasks-dependencies'
import { styles } from './mobile-tasks-legacy-styles'

export function renderMobileTasksProjectReviewPanels(model: ConnectionPresentationModel) {
  const {
    addProjectGitHubFileReviewComment,
    expandedPrFilePath,
    prFileCommentDrafts,
    prFileContents,
    prFileLoadingPath,
    projectAssignableUsersError,
    projectAssignableUsersLoading,
    projectMutating,
    projectReviewerCandidates,
    projectReviewersDraft,
    projectRowDetail,
    projectRowHostedRepo,
    projectRowItem,
    projectSelectedReviewerLogins,
    refreshProjectGitHubChecks,
    requestProjectGitHubReviewers,
    rerunProjectGitHubChecks,
    setPrFileCommentDrafts,
    setProjectReviewersDraft,
    toggleProjectGitHubFileExpansion,
    toggleProjectGitHubFileViewed
  } = model
  if (!projectRowItem) {
    return null
  }
  return SHOW_MOBILE_PROJECT_REVIEW_PANELS &&
    projectRowItem.itemType === 'PULL_REQUEST' &&
    projectRowDetail?.provider === 'github' &&
    projectRowHostedRepo ? (
    <>
      <View style={styles.detailSection}>
        <View style={styles.detailSectionHeader}>
          <Text style={styles.detailSectionTitle}>
            {translate('tasks.projectReviewPanels.reviewers', 'Reviewers')}
          </Text>
          <Text style={styles.detailSectionMeta}>{getGitHubReviewSummary(projectRowDetail)}</Text>
        </View>
        {getGitHubReviewerRows(projectRowDetail).length === 0 ? (
          <Text style={styles.detailMuted}>
            {translate('tasks.projectReviewPanels.noReviewers', 'No reviewers requested.')}
          </Text>
        ) : (
          getGitHubReviewerRows(projectRowDetail).map((reviewer) => (
            <View key={reviewer.login} style={styles.reviewerRow}>
              <View style={styles.reviewerAvatar}>
                <Text style={styles.reviewerAvatarText}>
                  {reviewer.login.slice(0, 1).toUpperCase()}
                </Text>
              </View>
              <View style={styles.reviewerInfo}>
                <Text style={styles.reviewerName} numberOfLines={1}>
                  {reviewer.login}
                </Text>
                {reviewer.name ? (
                  <Text style={styles.reviewerMeta} numberOfLines={1}>
                    {reviewer.name}
                  </Text>
                ) : null}
              </View>
              <Text style={styles.reviewerState}>{reviewer.stateLabel}</Text>
            </View>
          ))
        )}
        {projectAssignableUsersLoading ? (
          <View style={styles.detailLoadingInline}>
            <ActivityIndicator size="small" color={colors.textSecondary} />
            <Text style={styles.detailMuted}>
              {translate('tasks.projectReviewPanels.loadingReviewers', 'Loading reviewers...')}
            </Text>
          </View>
        ) : projectAssignableUsersError ? (
          <Text style={styles.detailError}>{projectAssignableUsersError}</Text>
        ) : projectReviewerCandidates.length === 0 ? (
          <Text style={styles.detailMuted}>
            {translate('tasks.projectReviewPanels.noSuggestions', 'No reviewer suggestions found.')}
          </Text>
        ) : (
          <View style={styles.chipRow}>
            {projectReviewerCandidates.map((user) => {
              const selected = projectSelectedReviewerLogins.has(user.login.trim().toLowerCase())
              return (
                <Pressable
                  key={user.login}
                  style={[styles.detailChip, selected ? styles.detailChipSelected : undefined]}
                  disabled={projectMutating || selected}
                  onPress={() => void requestProjectGitHubReviewers(projectRowItem, [user.login])}
                >
                  <View style={styles.issueTypeChipContent}>
                    {selected ? <Check size={12} color={colors.accentBlue} /> : null}
                    <Text style={styles.detailChipText}>{user.login}</Text>
                  </View>
                </Pressable>
              )
            })}
          </View>
        )}
        <TextInput
          style={styles.input}
          value={projectReviewersDraft}
          onChangeText={setProjectReviewersDraft}
          placeholder={translate('tasks.projectReviewPanels.requestReviewers', 'Request reviewers')}
          placeholderTextColor={colors.textMuted}
          autoCapitalize="none"
        />
        <Pressable
          style={styles.inlineSaveButton}
          disabled={projectMutating || splitReviewerList(projectReviewersDraft).length === 0}
          onPress={() => void requestProjectGitHubReviewers(projectRowItem)}
        >
          <Text style={styles.inlineSaveText}>
            {translate('tasks.projectReviewPanels.requestReview', 'Request review')}
          </Text>
        </Pressable>
      </View>

      {projectRowType(projectRowItem) === 'pr' ? (
        <View style={styles.detailSection}>
          <View style={styles.detailSectionHeader}>
            <Text style={styles.detailSectionTitle}>
              {translate('tasks.projectReviewPanels.checks', 'Checks')}
            </Text>
            <View style={styles.inlineActionRow}>
              <Pressable
                style={styles.inlineSaveButtonCompact}
                disabled={projectMutating}
                onPress={() => void refreshProjectGitHubChecks(projectRowItem)}
              >
                <Text style={styles.inlineSaveText}>{translate('common.refresh', 'Refresh')}</Text>
              </Pressable>
              <Pressable
                style={styles.inlineSaveButtonCompact}
                disabled={projectMutating || !projectRowDetail.checks.some(isBrokenCheck)}
                onPress={() => void rerunProjectGitHubChecks(projectRowItem, true)}
              >
                <Text style={styles.inlineSaveText}>
                  {translate('tasks.projectReviewPanels.rerunFailed', 'Rerun failed')}
                </Text>
              </Pressable>
              <Pressable
                style={styles.inlineSaveButtonCompact}
                disabled={projectMutating || projectRowDetail.checks.length === 0}
                onPress={() => void rerunProjectGitHubChecks(projectRowItem, false)}
              >
                <Text style={styles.inlineSaveText}>
                  {translate('tasks.projectReviewPanels.rerunAll', 'Rerun all')}
                </Text>
              </Pressable>
            </View>
          </View>
          {projectRowDetail.checks.length === 0 ? (
            <Text style={styles.detailMuted}>
              {translate('tasks.projectReviewPanels.noChecks', 'No checks found.')}
            </Text>
          ) : (
            projectRowDetail.checks.map((check) => (
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

      {projectRowDetail.files.length > 0 ? (
        <View style={styles.detailSection}>
          <Text style={styles.detailSectionTitle}>
            {translate('tasks.projectReviewPanels.changedFiles', 'Changed files')}
          </Text>
          {projectRowDetail.files.map((file) => (
            <View key={file.path} style={styles.fileCard}>
              <Pressable
                style={styles.fileActionRow}
                disabled={projectMutating}
                onPress={() => void toggleProjectGitHubFileExpansion(projectRowItem, file)}
              >
                <Text style={styles.detailLine}>
                  {file.path}
                  {typeof file.additions === 'number' || typeof file.deletions === 'number'
                    ? ` · +${file.additions ?? 0} -${file.deletions ?? 0}`
                    : ''}
                </Text>
                <Text style={styles.detailSectionMeta}>
                  {expandedPrFilePath === file.path
                    ? translate('tasks.projectReviewPanels.hideFile', 'Hide')
                    : translate('tasks.projectReviewPanels.viewFile', 'View')}
                </Text>
              </Pressable>
              <Pressable
                style={styles.inlineSaveButtonCompact}
                disabled={projectMutating || !projectRowDetail.pullRequestId}
                onPress={() => void toggleProjectGitHubFileViewed(projectRowItem, file)}
              >
                <Text style={styles.inlineSaveText}>
                  {file.viewerViewedState === 'VIEWED'
                    ? translate('tasks.projectReviewPanels.markUnviewed', 'Mark unviewed')
                    : translate('tasks.projectReviewPanels.markViewed', 'Mark viewed')}
                </Text>
              </Pressable>
              {expandedPrFilePath === file.path ? (
                <View style={styles.filePreview}>
                  {prFileLoadingPath === file.path ? (
                    <ActivityIndicator size="small" color={colors.textSecondary} />
                  ) : prFileContents[file.path]?.originalIsBinary ||
                    prFileContents[file.path]?.modifiedIsBinary ? (
                    <Text style={styles.detailMuted}>
                      {translate('tasks.projectReviewPanels.binaryFile', 'Binary file.')}
                    </Text>
                  ) : prFileContents[file.path] ? (
                    <GitHubPrFileDiff
                      filePath={file.path}
                      contents={prFileContents[file.path]}
                      commentDrafts={prFileCommentDrafts}
                      disabled={projectMutating}
                      onCommentDraftChange={(draftKey, next) =>
                        setPrFileCommentDrafts((current) => ({
                          ...current,
                          [draftKey]: next
                        }))
                      }
                      onSubmitComment={(line) =>
                        void addProjectGitHubFileReviewComment(projectRowItem, file, line)
                      }
                    />
                  ) : (
                    <Text style={styles.detailMuted}>
                      {translate(
                        'tasks.projectReviewPanels.fileUnavailable',
                        'File contents unavailable.'
                      )}
                    </Text>
                  )}
                </View>
              ) : null}
            </View>
          ))}
        </View>
      ) : null}
    </>
  ) : null
}
