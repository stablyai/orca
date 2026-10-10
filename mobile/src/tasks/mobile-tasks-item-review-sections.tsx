import type { ConnectionPresentationModel } from './use-mobile-tasks-connection-presentation'
import {
  SHOW_MOBILE_DETAIL_METADATA_EDITORS,
  SHOW_MOBILE_DETAIL_REVIEW_PANELS,
  getGitHubReviewSummary,
  getGitHubReviewerRows,
  splitReviewerList,
  GitHubPrFileDiff
} from './mobile-tasks-legacy-foundation'
import {
  TextInput,
  colors,
  Pressable,
  Text,
  MobileMarkdown,
  View,
  ActivityIndicator,
  Check
} from './mobile-tasks-dependencies'
import { styles } from './mobile-tasks-legacy-styles'

export function renderMobileTasksItemBodyEditor(model: ConnectionPresentationModel) {
  const {
    actionItem,
    detailPayload,
    itemBodyDraft,
    mutatingStatus,
    setItemBodyDraft,
    updateGitHubIssueMetadata,
    updateGitHubPullRequestMetadata,
    updateGitLabIssueMetadata
  } = model
  if (!actionItem || !detailPayload) {
    return null
  }
  return SHOW_MOBILE_DETAIL_METADATA_EDITORS &&
    ((actionItem.provider === 'github' &&
      detailPayload.provider === 'github' &&
      (actionItem.source.type === 'issue' || actionItem.source.type === 'pr')) ||
      (actionItem.provider === 'gitlab' &&
        detailPayload.provider === 'gitlab' &&
        (actionItem.source.type === 'issue' || actionItem.source.type === 'mr'))) ? (
    <>
      <TextInput
        style={[styles.input, styles.bodyInput]}
        value={itemBodyDraft}
        onChangeText={setItemBodyDraft}
        placeholder="Description"
        placeholderTextColor={colors.textMuted}
        multiline
        textAlignVertical="top"
      />
      <Pressable
        style={styles.inlineSaveButton}
        disabled={mutatingStatus || itemBodyDraft === detailPayload.body}
        onPress={() => {
          if (actionItem.provider === 'github' && actionItem.source.type === 'pr') {
            void updateGitHubPullRequestMetadata(actionItem, {
              body: itemBodyDraft
            })
            return
          }
          if (actionItem.provider === 'github' && actionItem.source.type === 'issue') {
            void updateGitHubIssueMetadata(actionItem, {
              body: itemBodyDraft
            })
            return
          }
          if (
            actionItem.provider === 'gitlab' &&
            (actionItem.source.type === 'issue' || actionItem.source.type === 'mr')
          ) {
            void updateGitLabIssueMetadata(actionItem, {
              body: itemBodyDraft
            })
          }
        }}
      >
        <Text style={styles.inlineSaveText}>Save description</Text>
      </Pressable>
      <MobileMarkdown content={itemBodyDraft} fallback="No description." />
    </>
  ) : (
    <MobileMarkdown
      content={detailPayload.provider === 'linear' ? detailPayload.description : detailPayload.body}
      fallback="No description."
    />
  )
}

export function renderMobileTasksItemReviewPanel(model: ConnectionPresentationModel) {
  const {
    actionItem,
    detailPayload,
    itemAssignableUsersError,
    itemAssignableUsersLoading,
    itemReviewerCandidates,
    itemReviewersDraft,
    itemSelectedReviewerLogins,
    mutatingStatus,
    requestGitHubReviewers,
    setItemReviewersDraft
  } = model
  if (!actionItem || !detailPayload) {
    return null
  }
  return SHOW_MOBILE_DETAIL_REVIEW_PANELS &&
    actionItem.provider === 'github' &&
    actionItem.source.type === 'pr' ? (
    <View style={styles.detailSection}>
      <View style={styles.detailSectionHeader}>
        <Text style={styles.detailSectionTitle}>Reviewers</Text>
        {detailPayload.provider === 'github' ? (
          <Text style={styles.detailSectionMeta}>{getGitHubReviewSummary(detailPayload)}</Text>
        ) : null}
      </View>
      {detailPayload.provider === 'github' ? (
        getGitHubReviewerRows(detailPayload).length === 0 ? (
          <Text style={styles.detailMuted}>No reviewers requested.</Text>
        ) : (
          getGitHubReviewerRows(detailPayload).map((reviewer) => (
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
        )
      ) : null}
      {itemAssignableUsersLoading ? (
        <View style={styles.detailLoadingInline}>
          <ActivityIndicator size="small" color={colors.textSecondary} />
          <Text style={styles.detailMuted}>Loading reviewers...</Text>
        </View>
      ) : itemAssignableUsersError ? (
        <Text style={styles.detailError}>{itemAssignableUsersError}</Text>
      ) : itemReviewerCandidates.length === 0 ? (
        <Text style={styles.detailMuted}>No reviewer suggestions found.</Text>
      ) : (
        <View style={styles.chipRow}>
          {itemReviewerCandidates.map((user) => {
            const selected = itemSelectedReviewerLogins.has(user.login.trim().toLowerCase())
            return (
              <Pressable
                key={user.login}
                style={[styles.detailChip, selected ? styles.detailChipSelected : undefined]}
                disabled={mutatingStatus || selected}
                onPress={() => void requestGitHubReviewers(actionItem, [user.login])}
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
        value={itemReviewersDraft}
        onChangeText={setItemReviewersDraft}
        placeholder="Request reviewers"
        placeholderTextColor={colors.textMuted}
        autoCapitalize="none"
      />
      <Pressable
        style={styles.inlineSaveButton}
        disabled={mutatingStatus || splitReviewerList(itemReviewersDraft).length === 0}
        onPress={() => void requestGitHubReviewers(actionItem)}
      >
        <Text style={styles.inlineSaveText}>Request review</Text>
      </Pressable>
    </View>
  ) : null
}

export function renderMobileTasksItemFiles(model: ConnectionPresentationModel) {
  const {
    actionItem,
    addGitHubFileReviewComment,
    detailPayload,
    expandedPrFilePath,
    mutatingStatus,
    prFileCommentDrafts,
    prFileContents,
    prFileLoadingPath,
    setPrFileCommentDrafts,
    toggleGitHubFileExpansion,
    toggleGitHubFileViewed
  } = model
  if (!actionItem || !detailPayload) {
    return null
  }
  return SHOW_MOBILE_DETAIL_REVIEW_PANELS &&
    detailPayload.provider === 'github' &&
    detailPayload.files.length > 0 ? (
    <View style={styles.detailSection}>
      <Text style={styles.detailSectionTitle}>Changed files</Text>
      {detailPayload.files.map((file) =>
        actionItem.provider === 'github' && actionItem.source.type === 'pr' ? (
          <View key={file.path} style={styles.fileCard}>
            <Pressable
              style={styles.fileActionRow}
              disabled={mutatingStatus}
              onPress={() => void toggleGitHubFileExpansion(actionItem, file)}
            >
              <Text style={styles.detailLine}>
                {file.path}
                {typeof file.additions === 'number' || typeof file.deletions === 'number'
                  ? ` · +${file.additions ?? 0} -${file.deletions ?? 0}`
                  : ''}
              </Text>
              <Text style={styles.detailSectionMeta}>
                {expandedPrFilePath === file.path ? 'Hide' : 'View'}
              </Text>
            </Pressable>
            <Pressable
              style={styles.inlineSaveButtonCompact}
              disabled={mutatingStatus || !detailPayload.pullRequestId}
              onPress={() => void toggleGitHubFileViewed(actionItem, file)}
            >
              <Text style={styles.inlineSaveText}>
                {file.viewerViewedState === 'VIEWED' ? 'Mark unviewed' : 'Mark viewed'}
              </Text>
            </Pressable>
            {expandedPrFilePath === file.path ? (
              <View style={styles.filePreview}>
                {prFileLoadingPath === file.path ? (
                  <ActivityIndicator size="small" color={colors.textSecondary} />
                ) : prFileContents[file.path]?.originalIsBinary ||
                  prFileContents[file.path]?.modifiedIsBinary ? (
                  <Text style={styles.detailMuted}>Binary file.</Text>
                ) : prFileContents[file.path] ? (
                  <GitHubPrFileDiff
                    filePath={file.path}
                    contents={prFileContents[file.path]}
                    commentDrafts={prFileCommentDrafts}
                    disabled={mutatingStatus}
                    onCommentDraftChange={(draftKey, next) =>
                      setPrFileCommentDrafts((current) => ({
                        ...current,
                        [draftKey]: next
                      }))
                    }
                    onSubmitComment={(line) =>
                      void addGitHubFileReviewComment(actionItem, file, line)
                    }
                  />
                ) : (
                  <Text style={styles.detailMuted}>File contents unavailable.</Text>
                )}
              </View>
            ) : null}
          </View>
        ) : (
          <Text key={file.path} style={styles.detailLine}>
            {file.path}
            {typeof file.additions === 'number' || typeof file.deletions === 'number'
              ? ` · +${file.additions ?? 0} -${file.deletions ?? 0}`
              : ''}
          </Text>
        )
      )}
    </View>
  ) : null
}
