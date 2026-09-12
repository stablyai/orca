import type { ConnectionPresentationModel } from './use-mobile-tasks-connection-presentation'
import {
  SHOW_MOBILE_PROJECT_METADATA_EDITORS,
  editableProjectFields,
  projectFieldValueLabel
} from './mobile-tasks-legacy-foundation'
import { View, Text, Pressable, Check, colors, TextInput } from './mobile-tasks-dependencies'
import { styles } from './mobile-tasks-legacy-styles'

export function renderMobileTasksProjectFieldEditors(model: ConnectionPresentationModel) {
  const {
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
      <Text style={styles.detailSectionTitle}>Project fields</Text>
      {editableProjectFields(githubProjectTable).map((field) => {
        const currentLabel = projectFieldValueLabel(projectRowItem, field)
        const draftValue = projectFieldDrafts[field.id] ?? ''
        const saveTextField = (): void => {
          if (field.dataType === 'NUMBER') {
            const number = Number(draftValue)
            if (!Number.isFinite(number)) {
              setProjectRowDetailError('Enter a valid number.')
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
              setProjectRowDetailError('Enter a date as YYYY-MM-DD.')
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
                      style={[styles.detailChip, selected ? styles.detailChipSelected : undefined]}
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
                  <Text style={styles.detailMuted}>No iterations available.</Text>
                ) : (
                  field.iterations.map((iteration) => {
                    const fieldValue = projectRowItem.fieldValuesByFieldId?.[field.id]
                    const selected =
                      fieldValue?.kind === 'iteration' && fieldValue.iterationId === iteration.id
                    return (
                      <Pressable
                        key={iteration.id}
                        style={styles.actionRow}
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
                            {iteration.completed ? 'Completed' : 'Current & upcoming'} ·{' '}
                            {iteration.startDate} · {iteration.duration}d
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
                <TextInput
                  style={styles.input}
                  value={draftValue}
                  onChangeText={(next) =>
                    setProjectFieldDrafts((current) => ({
                      ...current,
                      [field.id]: next
                    }))
                  }
                  placeholder={
                    field.dataType === 'DATE'
                      ? 'YYYY-MM-DD'
                      : field.dataType === 'NUMBER'
                        ? 'Number'
                        : 'Text'
                  }
                  placeholderTextColor={colors.textMuted}
                  keyboardType={field.dataType === 'NUMBER' ? 'numeric' : 'default'}
                  autoCapitalize="none"
                />
                <Pressable
                  style={styles.inlineSaveButton}
                  disabled={projectMutating}
                  onPress={saveTextField}
                >
                  <Text style={styles.inlineSaveText}>Save field</Text>
                </Pressable>
              </>
            )}
            <Pressable
              style={styles.inlineSaveButton}
              disabled={projectMutating || currentLabel === 'Empty'}
              onPress={() => void mutateProjectRowField(projectRowItem, field, null)}
            >
              <Text style={styles.inlineSaveText}>Clear field</Text>
            </Pressable>
          </View>
        )
      })}
    </View>
  ) : null
}
