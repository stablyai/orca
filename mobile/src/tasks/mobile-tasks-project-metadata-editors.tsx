import type { ConnectionPresentationModel } from './use-mobile-tasks-connection-presentation'
import {
  SHOW_MOBILE_PROJECT_METADATA_EDITORS,
  projectRowType
} from './mobile-tasks-legacy-foundation'
import {
  View,
  Text,
  ActivityIndicator,
  colors,
  Pressable,
  Check,
  TextInput,
  MobileMarkdown
} from './mobile-tasks-dependencies'
import { styles } from './mobile-tasks-legacy-styles'

export function renderMobileTasksProjectLabelsEditor(model: ConnectionPresentationModel) {
  const {
    mutateProjectRowMetadata,
    projectAvailableLabels,
    projectLabelsError,
    projectLabelsLoading,
    projectMutating,
    projectRowDetail,
    projectRowItem
  } = model
  if (!projectRowItem) {
    return null
  }
  return SHOW_MOBILE_PROJECT_METADATA_EDITORS && projectRowType(projectRowItem) ? (
    <View style={styles.detailSection}>
      <View style={styles.detailSectionHeader}>
        <Text style={styles.detailSectionTitle}>Labels</Text>
        <Text style={styles.detailSectionMeta}>
          {(projectRowDetail?.provider === 'github'
            ? projectRowDetail.labels
            : projectRowItem.content.labels.map((label) => label.name)
          ).length || 'None'}
        </Text>
      </View>
      {projectLabelsLoading ? (
        <View style={styles.detailLoadingInline}>
          <ActivityIndicator size="small" color={colors.textSecondary} />
          <Text style={styles.detailMuted}>Loading labels...</Text>
        </View>
      ) : projectLabelsError ? (
        <Text style={styles.detailError}>{projectLabelsError}</Text>
      ) : projectAvailableLabels.length === 0 ? (
        <Text style={styles.detailMuted}>No labels in this repository.</Text>
      ) : (
        <View style={styles.chipRow}>
          {[
            ...new Set([
              ...projectAvailableLabels,
              ...(projectRowDetail?.provider === 'github'
                ? projectRowDetail.labels
                : projectRowItem.content.labels.map((label) => label.name))
            ])
          ].map((label) => {
            const selected = (
              projectRowDetail?.provider === 'github'
                ? projectRowDetail.labels
                : projectRowItem.content.labels.map((entry) => entry.name)
            ).includes(label)
            return (
              <Pressable
                key={label}
                style={[styles.detailChip, selected ? styles.detailChipSelected : undefined]}
                disabled={projectMutating}
                onPress={() =>
                  void mutateProjectRowMetadata(
                    projectRowItem,
                    selected ? { removeLabels: [label] } : { addLabels: [label] }
                  )
                }
              >
                <View style={styles.issueTypeChipContent}>
                  {selected ? <Check size={12} color={colors.accentBlue} /> : null}
                  <Text style={styles.detailChipText}>{label}</Text>
                </View>
              </Pressable>
            )
          })}
        </View>
      )}
    </View>
  ) : null
}

export function renderMobileTasksProjectAssigneesEditor(model: ConnectionPresentationModel) {
  const {
    mutateProjectRowMetadata,
    projectAssignableUsers,
    projectAssignableUsersError,
    projectAssignableUsersLoading,
    projectMutating,
    projectRowDetail,
    projectRowItem
  } = model
  if (!projectRowItem) {
    return null
  }
  return SHOW_MOBILE_PROJECT_METADATA_EDITORS && projectRowType(projectRowItem) ? (
    <View style={styles.detailSection}>
      <View style={styles.detailSectionHeader}>
        <Text style={styles.detailSectionTitle}>Assignees</Text>
        <Text style={styles.detailSectionMeta}>
          {(projectRowDetail?.provider === 'github'
            ? projectRowDetail.assignees
            : projectRowItem.content.assignees.map((assignee) => assignee.login)
          ).length || 'None'}
        </Text>
      </View>
      {projectAssignableUsersLoading ? (
        <View style={styles.detailLoadingInline}>
          <ActivityIndicator size="small" color={colors.textSecondary} />
          <Text style={styles.detailMuted}>Loading assignees...</Text>
        </View>
      ) : projectAssignableUsersError ? (
        <Text style={styles.detailError}>{projectAssignableUsersError}</Text>
      ) : projectAssignableUsers.length === 0 ? (
        <Text style={styles.detailMuted}>No assignable users found for this repository.</Text>
      ) : (
        <View style={styles.chipRow}>
          {[
            ...new Map(
              [
                ...projectAssignableUsers,
                ...projectRowItem.content.assignees,
                ...(projectRowDetail?.provider === 'github'
                  ? projectRowDetail.assignees.map((login) => ({
                      login,
                      name: null,
                      avatarUrl: null
                    }))
                  : [])
              ].map((user) => [user.login, user])
            ).values()
          ].map((user) => {
            const selected = (
              projectRowDetail?.provider === 'github'
                ? projectRowDetail.assignees
                : projectRowItem.content.assignees.map((assignee) => assignee.login)
            ).includes(user.login)
            return (
              <Pressable
                key={user.login}
                style={[styles.detailChip, selected ? styles.detailChipSelected : undefined]}
                disabled={projectMutating}
                onPress={() =>
                  void mutateProjectRowMetadata(
                    projectRowItem,
                    selected ? { removeAssignees: [user.login] } : { addAssignees: [user.login] }
                  )
                }
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
    </View>
  ) : null
}

export function renderMobileTasksProjectIssueMetadata(model: ConnectionPresentationModel) {
  const {
    mutateProjectRowIssueOrPr,
    projectBodyDraft,
    projectMutating,
    projectRowDetail,
    projectRowItem,
    projectTitleDraft,
    setProjectBodyDraft,
    setProjectTitleDraft
  } = model
  if (!projectRowItem) {
    return null
  }
  return SHOW_MOBILE_PROJECT_METADATA_EDITORS && projectRowType(projectRowItem) ? (
    <>
      <View style={styles.detailSection}>
        <Text style={styles.detailSectionTitle}>Title</Text>
        <TextInput
          style={styles.input}
          value={projectTitleDraft}
          onChangeText={setProjectTitleDraft}
          placeholder="Title"
          placeholderTextColor={colors.textMuted}
        />
        <Pressable
          style={styles.inlineSaveButton}
          disabled={projectMutating || projectTitleDraft.trim() === projectRowItem.content.title}
          onPress={() =>
            void mutateProjectRowIssueOrPr(projectRowItem, {
              title: projectTitleDraft.trim()
            })
          }
        >
          <Text style={styles.inlineSaveText}>Save title</Text>
        </Pressable>
      </View>
      <View style={styles.detailSection}>
        <Text style={styles.detailSectionTitle}>Description</Text>
        <TextInput
          style={[styles.input, styles.bodyInput]}
          value={projectBodyDraft}
          onChangeText={setProjectBodyDraft}
          placeholder="Description"
          placeholderTextColor={colors.textMuted}
          multiline
          textAlignVertical="top"
        />
        <Pressable
          style={styles.inlineSaveButton}
          disabled={
            projectMutating ||
            projectBodyDraft ===
              (projectRowDetail?.provider === 'github'
                ? projectRowDetail.body
                : (projectRowItem.content.body ?? ''))
          }
          onPress={() =>
            void mutateProjectRowIssueOrPr(projectRowItem, {
              body: projectBodyDraft
            })
          }
        >
          <Text style={styles.inlineSaveText}>Save description</Text>
        </Pressable>
        <MobileMarkdown content={projectBodyDraft} fallback="No description." />
      </View>
    </>
  ) : (
    <>
      <View style={styles.detailSection}>
        <Text style={styles.detailSectionTitle}>Title</Text>
        <Text style={styles.detailLine}>{projectRowItem.content.title}</Text>
      </View>
      <View style={styles.detailSection}>
        <Text style={styles.detailSectionTitle}>Description</Text>
        <MobileMarkdown content={projectBodyDraft} fallback="No description." />
      </View>
    </>
  )
}
