import type { ConnectionPresentationModel } from './use-mobile-tasks-connection-presentation'
import { translate } from '../i18n/mobile-i18n'
import {
  SHOW_MOBILE_DETAIL_METADATA_EDITORS,
  splitCommaList
} from './mobile-tasks-legacy-foundation'
import {
  View,
  Text,
  TextField,
  colors,
  Pressable,
  ActivityIndicator,
  Check
} from './mobile-tasks-dependencies'
import { styles } from './mobile-tasks-legacy-styles'
import { SectionHeader } from '../components/list/SectionHeader'

export function renderMobileTasksItemFieldEditors(model: ConnectionPresentationModel) {
  const {
    actionItem,
    detailPayload,
    itemAddAssigneesDraft,
    itemAddLabelsDraft,
    itemAssignableUsers,
    itemAssignableUsersError,
    itemAssignableUsersLoading,
    itemAvailableLabels,
    itemLabelsError,
    itemLabelsLoading,
    itemRemoveAssigneesDraft,
    itemRemoveLabelsDraft,
    itemTitleDraft,
    mutatingStatus,
    setItemAddAssigneesDraft,
    setItemAddLabelsDraft,
    setItemRemoveAssigneesDraft,
    setItemRemoveLabelsDraft,
    setItemTitleDraft,
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
        (actionItem.source.type === 'issue' || actionItem.source.type === 'mr') &&
        detailPayload.provider === 'gitlab')) ? (
    <>
      <SectionHeader title={translate('tasks.itemFieldEditors.title', 'Title')} />
      <View style={styles.itemSectionBody}>
        <TextField
          value={itemTitleDraft}
          onChangeText={setItemTitleDraft}
          placeholder={translate('tasks.itemFieldEditors.title', 'Title')}
        />
        <Pressable
          style={styles.inlineSaveButton}
          disabled={
            mutatingStatus ||
            itemTitleDraft.trim().length === 0 ||
            itemTitleDraft.trim() === actionItem.title
          }
          onPress={() => {
            if (actionItem.provider === 'github' && actionItem.source.type === 'pr') {
              void updateGitHubPullRequestMetadata(actionItem, {
                title: itemTitleDraft.trim()
              })
              return
            }
            if (actionItem.provider === 'github') {
              void updateGitHubIssueMetadata(actionItem, {
                title: itemTitleDraft.trim()
              })
              return
            }
            if (actionItem.provider === 'gitlab') {
              void updateGitLabIssueMetadata(actionItem, {
                title: itemTitleDraft.trim()
              })
            }
          }}
        >
          <Text style={styles.inlineSaveText}>
            {translate('tasks.itemFieldEditors.saveTitle', 'Save title')}
          </Text>
        </Pressable>
      </View>

      <SectionHeader
        title={translate('tasks.itemFieldEditors.labels', 'Labels')}
        trailing={String(
          detailPayload.labels.length || translate('tasks.itemFieldEditors.none', 'None')
        )}
      />
      <View style={styles.itemSectionBody}>
        {actionItem.provider === 'github' ? (
          itemLabelsLoading ? (
            <View style={styles.detailLoadingInline}>
              <ActivityIndicator size="small" color={colors.textSecondary} />
              <Text style={styles.detailMuted}>
                {translate('tasks.itemFieldEditors.loadingLabels', 'Loading labels...')}
              </Text>
            </View>
          ) : itemLabelsError ? (
            <Text style={styles.detailError}>{itemLabelsError}</Text>
          ) : itemAvailableLabels.length === 0 ? (
            <Text style={styles.detailMuted}>
              {translate('tasks.itemFieldEditors.noLabels', 'No labels in this repository.')}
            </Text>
          ) : (
            <View style={styles.chipRow}>
              {[...new Set([...itemAvailableLabels, ...detailPayload.labels])].map((label) => {
                const selected = detailPayload.labels.includes(label)
                return (
                  <Pressable
                    key={label}
                    style={[styles.detailChip, selected ? styles.detailChipSelected : undefined]}
                    disabled={mutatingStatus}
                    onPress={() =>
                      void updateGitHubIssueMetadata(
                        actionItem,
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
          )
        ) : (
          <>
            <TextField
              value={itemAddLabelsDraft}
              onChangeText={setItemAddLabelsDraft}
              placeholder={translate(
                'tasks.itemFieldEditors.addLabels',
                'Add labels, comma separated'
              )}
              autoCapitalize="none"
            />
            <TextField
              style={styles.stackedInput}
              value={itemRemoveLabelsDraft}
              onChangeText={setItemRemoveLabelsDraft}
              placeholder={translate(
                'tasks.itemFieldEditors.removeLabels',
                'Remove labels, comma separated'
              )}
              autoCapitalize="none"
            />
            <Pressable
              style={styles.inlineSaveButton}
              disabled={
                mutatingStatus ||
                (splitCommaList(itemAddLabelsDraft).length === 0 &&
                  splitCommaList(itemRemoveLabelsDraft).length === 0)
              }
              onPress={() =>
                void updateGitLabIssueMetadata(actionItem, {
                  addLabels: splitCommaList(itemAddLabelsDraft),
                  removeLabels: splitCommaList(itemRemoveLabelsDraft)
                })
              }
            >
              <Text style={styles.inlineSaveText}>
                {translate('tasks.itemFieldEditors.updateLabels', 'Update labels')}
              </Text>
            </Pressable>
          </>
        )}
      </View>

      <SectionHeader
        title={translate('tasks.itemFieldEditors.assignees', 'Assignees')}
        trailing={String(
          detailPayload.assignees.length || translate('tasks.itemFieldEditors.none', 'None')
        )}
      />
      <View style={styles.itemSectionBody}>
        {actionItem.provider === 'github' ? (
          itemAssignableUsersLoading ? (
            <View style={styles.detailLoadingInline}>
              <ActivityIndicator size="small" color={colors.textSecondary} />
              <Text style={styles.detailMuted}>
                {translate('tasks.itemFieldEditors.loadingAssignees', 'Loading assignees...')}
              </Text>
            </View>
          ) : itemAssignableUsersError ? (
            <Text style={styles.detailError}>{itemAssignableUsersError}</Text>
          ) : itemAssignableUsers.length === 0 ? (
            <Text style={styles.detailMuted}>
              {translate(
                'tasks.itemFieldEditors.noAssignableUsers',
                'No assignable users found for this repository.'
              )}
            </Text>
          ) : (
            <View style={styles.chipRow}>
              {[
                ...new Map(
                  [
                    ...itemAssignableUsers,
                    ...detailPayload.assignees.map((login) => ({
                      login,
                      name: null,
                      avatarUrl: null
                    }))
                  ].map((user) => [user.login, user])
                ).values()
              ].map((user) => {
                const selected = detailPayload.assignees.includes(user.login)
                return (
                  <Pressable
                    key={user.login}
                    style={[styles.detailChip, selected ? styles.detailChipSelected : undefined]}
                    disabled={mutatingStatus}
                    onPress={() =>
                      void updateGitHubIssueMetadata(
                        actionItem,
                        selected
                          ? { removeAssignees: [user.login] }
                          : { addAssignees: [user.login] }
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
          )
        ) : actionItem.source.type === 'issue' ? (
          <>
            <TextField
              value={itemAddAssigneesDraft}
              onChangeText={setItemAddAssigneesDraft}
              placeholder={translate(
                'tasks.itemFieldEditors.addUsernames',
                'Add usernames, comma separated'
              )}
              autoCapitalize="none"
            />
            <TextField
              style={styles.stackedInput}
              value={itemRemoveAssigneesDraft}
              onChangeText={setItemRemoveAssigneesDraft}
              placeholder={translate(
                'tasks.itemFieldEditors.removeUsernames',
                'Remove usernames, comma separated'
              )}
              autoCapitalize="none"
            />
            <Pressable
              style={styles.inlineSaveButton}
              disabled={
                mutatingStatus ||
                (splitCommaList(itemAddAssigneesDraft).length === 0 &&
                  splitCommaList(itemRemoveAssigneesDraft).length === 0)
              }
              onPress={() =>
                void updateGitLabIssueMetadata(actionItem, {
                  addAssignees: splitCommaList(itemAddAssigneesDraft),
                  removeAssignees: splitCommaList(itemRemoveAssigneesDraft)
                })
              }
            >
              <Text style={styles.inlineSaveText}>
                {translate('tasks.itemFieldEditors.updateAssignees', 'Update assignees')}
              </Text>
            </Pressable>
          </>
        ) : null}
      </View>
    </>
  ) : null
}
