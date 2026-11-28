import type { ConnectionPresentationModel } from '../screen-state/use-mobile-tasks-connection-presentation'
import { SHOW_MOBILE_DETAIL_METADATA_EDITORS } from '../task-list/mobile-tasks-options'
import { splitCommaList } from './mobile-tasks-reviewer-linear'
import { View, Text, Pressable, ActivityIndicator } from 'react-native'
import { TextField } from '../../components/composer-input/TextField'
import { pressedStyle } from '../../theme/mobile-theme'
import { Check } from 'lucide-react-native'
import { SectionHeader } from '../../components/list/ListGroup'

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
    updateGitLabIssueMetadata,
    colors,
    styles,
    t
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
      <SectionHeader title={t('tasks.itemFieldEditors.title', 'Title')} />
      <View style={styles.itemSectionBody}>
        <TextField
          value={itemTitleDraft}
          onChangeText={setItemTitleDraft}
          placeholder={t('tasks.itemFieldEditors.title', 'Title')}
        />
        <Pressable
          style={({ pressed }) => [styles.inlineSaveButton, pressed && pressedStyle]}
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
            {t('tasks.itemFieldEditors.saveTitle', 'Save title')}
          </Text>
        </Pressable>
      </View>

      <SectionHeader
        title={t('tasks.itemFieldEditors.labels', 'Labels')}
        trailing={String(detailPayload.labels.length || t('tasks.itemFieldEditors.none', 'None'))}
      />
      <View style={styles.itemSectionBody}>
        {actionItem.provider === 'github' ? (
          itemLabelsLoading ? (
            <View style={styles.detailLoadingInline}>
              <ActivityIndicator size="small" color={colors.textSecondary} />
              <Text style={styles.detailMuted}>
                {t('tasks.itemFieldEditors.loadingLabels', 'Loading labels...')}
              </Text>
            </View>
          ) : itemLabelsError ? (
            <Text style={styles.detailError}>{itemLabelsError}</Text>
          ) : itemAvailableLabels.length === 0 ? (
            <Text style={styles.detailMuted}>
              {t('tasks.itemFieldEditors.noLabels', 'No labels in this repository.')}
            </Text>
          ) : (
            <View style={styles.chipRow}>
              {[...new Set([...itemAvailableLabels, ...detailPayload.labels])].map((label) => {
                const selected = detailPayload.labels.includes(label)
                return (
                  <Pressable
                    key={label}
                    style={({ pressed }) => [
                      styles.detailChip,
                      selected ? styles.detailChipSelected : undefined,
                      pressed && pressedStyle
                    ]}
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
              placeholder={t('tasks.itemFieldEditors.addLabels', 'Add labels, comma separated')}
              autoCapitalize="none"
            />
            <TextField
              style={styles.stackedInput}
              value={itemRemoveLabelsDraft}
              onChangeText={setItemRemoveLabelsDraft}
              placeholder={t(
                'tasks.itemFieldEditors.removeLabels',
                'Remove labels, comma separated'
              )}
              autoCapitalize="none"
            />
            <Pressable
              style={({ pressed }) => [styles.inlineSaveButton, pressed && pressedStyle]}
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
                {t('tasks.itemFieldEditors.updateLabels', 'Update labels')}
              </Text>
            </Pressable>
          </>
        )}
      </View>

      <SectionHeader
        title={t('tasks.itemFieldEditors.assignees', 'Assignees')}
        trailing={String(
          detailPayload.assignees.length || t('tasks.itemFieldEditors.none', 'None')
        )}
      />
      <View style={styles.itemSectionBody}>
        {actionItem.provider === 'github' ? (
          itemAssignableUsersLoading ? (
            <View style={styles.detailLoadingInline}>
              <ActivityIndicator size="small" color={colors.textSecondary} />
              <Text style={styles.detailMuted}>
                {t('tasks.itemFieldEditors.loadingAssignees', 'Loading assignees...')}
              </Text>
            </View>
          ) : itemAssignableUsersError ? (
            <Text style={styles.detailError}>{itemAssignableUsersError}</Text>
          ) : itemAssignableUsers.length === 0 ? (
            <Text style={styles.detailMuted}>
              {t(
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
                    style={({ pressed }) => [
                      styles.detailChip,
                      selected ? styles.detailChipSelected : undefined,
                      pressed && pressedStyle
                    ]}
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
              placeholder={t(
                'tasks.itemFieldEditors.addUsernames',
                'Add usernames, comma separated'
              )}
              autoCapitalize="none"
            />
            <TextField
              style={styles.stackedInput}
              value={itemRemoveAssigneesDraft}
              onChangeText={setItemRemoveAssigneesDraft}
              placeholder={t(
                'tasks.itemFieldEditors.removeUsernames',
                'Remove usernames, comma separated'
              )}
              autoCapitalize="none"
            />
            <Pressable
              style={({ pressed }) => [styles.inlineSaveButton, pressed && pressedStyle]}
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
                {t('tasks.itemFieldEditors.updateAssignees', 'Update assignees')}
              </Text>
            </Pressable>
          </>
        ) : null}
      </View>
    </>
  ) : null
}
