import type { ConnectionPresentationModel } from '../screen-state/use-mobile-tasks-connection-presentation'
import { SHOW_MOBILE_PROJECT_METADATA_EDITORS } from '../task-list/mobile-tasks-options'
import { editableProjectFields, projectFieldValueLabel } from './mobile-tasks-project-fields'
import { View, Text, Pressable } from 'react-native'
import { Check } from 'lucide-react-native'
import { pressedStyle } from '../../theme/mobile-theme'
import { TextField } from '../../components/composer-input/TextField'

export function renderMobileTasksProjectFieldEditors(model: ConnectionPresentationModel) {
  const {
    colors,
    styles,
    t,
    githubProjectTable,
    mutateProjectRowField,
    projectFieldDrafts,
    projectMutating,
    projectRowItem,
    setProjectFieldDrafts,
    setProjectRowDetailError
  } = model
  if (!projectRowItem) {
    return null
  }
  return SHOW_MOBILE_PROJECT_METADATA_EDITORS &&
    editableProjectFields(githubProjectTable).length > 0 ? (
    <View style={styles.detailSection}>
      <Text style={styles.detailSectionTitle}>
        {t('tasks.projectFieldEditors.projectFields', 'Project fields')}
      </Text>
      {editableProjectFields(githubProjectTable).map((field) => {
        const currentLabel = projectFieldValueLabel(projectRowItem, field)
        const currentValue = projectRowItem.fieldValuesByFieldId?.[field.id]
        const isEmpty =
          !currentValue ||
          (currentValue.kind === 'text' && !currentValue.text) ||
          (currentValue.kind === 'labels' && currentValue.labels.length === 0) ||
          (currentValue.kind === 'users' && currentValue.users.length === 0)
        const draftValue = projectFieldDrafts[field.id] ?? ''
        const saveTextField = (): void => {
          if (field.dataType === 'NUMBER') {
            const number = Number(draftValue)
            if (!Number.isFinite(number)) {
              setProjectRowDetailError(
                t('tasks.projectFieldEditors.invalidNumber', 'Enter a valid number.')
              )
              return
            }
            void mutateProjectRowField(projectRowItem, field, {
              kind: 'number',
              number
            })
            return
          }
          if (field.dataType === 'DATE') {
            const date = draftValue.trim()
            if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
              setProjectRowDetailError(
                t('tasks.projectFieldEditors.invalidDate', 'Enter a date as YYYY-MM-DD.')
              )
              return
            }
            void mutateProjectRowField(projectRowItem, field, { kind: 'date', date })
            return
          }
          void mutateProjectRowField(projectRowItem, field, {
            kind: 'text',
            text: draftValue
          })
        }
        return (
          <View key={field.id} style={styles.projectFieldCard}>
            <View style={styles.detailSectionHeader}>
              <Text style={styles.projectFieldName}>{field.name}</Text>
              <Text style={styles.projectFieldValue} numberOfLines={1}>
                {currentLabel}
              </Text>
            </View>
            {field.dataType === 'SINGLE_SELECT' && field.kind === 'single-select' ? (
              <View style={styles.chipRow}>
                {field.options.map((option) => {
                  const fieldValue = projectRowItem.fieldValuesByFieldId?.[field.id]
                  const selected =
                    fieldValue?.kind === 'single-select' && fieldValue.optionId === option.id
                  return (
                    <Pressable
                      key={option.id}
                      style={({ pressed }) => [
                        styles.detailChip,
                        selected ? styles.detailChipSelected : undefined,
                        pressed && pressedStyle
                      ]}
                      disabled={projectMutating}
                      accessibilityState={{ selected }}
                      onPress={() =>
                        void mutateProjectRowField(projectRowItem, field, {
                          kind: 'single-select',
                          optionId: option.id
                        })
                      }
                    >
                      <View style={styles.issueTypeChipContent}>
                        {selected ? <Check size={12} color={colors.accentBlue} /> : null}
                        <Text style={styles.detailChipText}>{option.name}</Text>
                      </View>
                    </Pressable>
                  )
                })}
              </View>
            ) : field.dataType === 'ITERATION' && field.kind === 'iteration' ? (
              <View style={styles.projectIterationList}>
                {field.iterations.length === 0 ? (
                  <Text style={styles.detailMuted}>
                    {t('tasks.projectFieldEditors.noIterations', 'No iterations available.')}
                  </Text>
                ) : (
                  field.iterations.map((iteration) => {
                    const fieldValue = projectRowItem.fieldValuesByFieldId?.[field.id]
                    const selected =
                      fieldValue?.kind === 'iteration' && fieldValue.iterationId === iteration.id
                    return (
                      <Pressable
                        key={iteration.id}
                        style={({ pressed }) => [
                          styles.actionRow,
                          pressed && { backgroundColor: colors.translucentFill }
                        ]}
                        disabled={projectMutating}
                        accessibilityState={{ selected }}
                        onPress={() =>
                          void mutateProjectRowField(projectRowItem, field, {
                            kind: 'iteration',
                            iterationId: iteration.id
                          })
                        }
                      >
                        <View style={styles.projectIterationCopy}>
                          <Text style={styles.actionText}>{iteration.title}</Text>
                          <Text style={styles.detailMuted}>
                            {iteration.completed
                              ? t(
                                  'tasks.projectFieldEditors.completedIteration',
                                  'Completed · {{startDate}} · {{duration}}d',
                                  {
                                    startDate: iteration.startDate,
                                    duration: iteration.duration
                                  }
                                )
                              : t(
                                  'tasks.projectFieldEditors.upcomingIteration',
                                  'Current & upcoming · {{startDate}} · {{duration}}d',
                                  {
                                    startDate: iteration.startDate,
                                    duration: iteration.duration
                                  }
                                )}
                          </Text>
                        </View>
                        {selected ? <Check size={14} color={colors.textSecondary} /> : null}
                      </Pressable>
                    )
                  })
                )}
              </View>
            ) : (
              <>
                <TextField
                  value={draftValue}
                  onChangeText={(next) =>
                    setProjectFieldDrafts((current) => ({
                      ...current,
                      [field.id]: next
                    }))
                  }
                  placeholder={
                    field.dataType === 'DATE'
                      ? t('tasks.projectFieldEditors.datePlaceholder', 'YYYY-MM-DD')
                      : field.dataType === 'NUMBER'
                        ? t('tasks.projectFieldEditors.numberPlaceholder', 'Number')
                        : t('tasks.projectFieldEditors.textPlaceholder', 'Text')
                  }
                  keyboardType={field.dataType === 'NUMBER' ? 'numeric' : 'default'}
                  autoCapitalize="none"
                />
                <Pressable
                  style={({ pressed }) => [styles.inlineSaveButton, pressed && pressedStyle]}
                  disabled={projectMutating}
                  onPress={saveTextField}
                >
                  <Text style={styles.inlineSaveText}>
                    {t('tasks.projectFieldEditors.saveField', 'Save field')}
                  </Text>
                </Pressable>
              </>
            )}
            <Pressable
              style={({ pressed }) => [styles.inlineSaveButton, pressed && pressedStyle]}
              disabled={projectMutating || isEmpty}
              onPress={() => void mutateProjectRowField(projectRowItem, field, null)}
            >
              <Text style={styles.inlineSaveText}>
                {t('tasks.projectFieldEditors.clearField', 'Clear field')}
              </Text>
            </Pressable>
          </View>
        )
      })}
    </View>
  ) : null
}
