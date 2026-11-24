import { PhoneRecurringAnswerFields } from './PhoneRecurringAnswer'
import { useCommanderDetailBack } from './commander-detail-back'
import {
  createHandoffPageId,
  encodeHandoffBody,
  HANDOFF_GOAL_LIMIT,
  HANDOFF_SECTION_LIMIT
} from '../../../src/shared/commander/goal-handoff'
import { useState, type ReactNode } from 'react'
import { Text, TextInput, View, ScrollView } from 'react-native'
import { ConfirmModal } from '../components/sheets/ConfirmModal'
import { PickerModal } from '../components/sheets/PickerModal'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { MemoryButton, s } from './phone-memory-controls'
import {
  draftHandoffFields,
  memoryDraft,
  updateMemoryDraft,
  validRecurringDraft,
  type MemoryDraft
} from './phone-memory-draft'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'

export function PhoneMemoryEditor({
  capture,
  draft,
  setDraft,
  projects,
  active,
  busy,
  conflict,
  labels,
  allProjects,
  problem,
  clearConflict,
  save,
  resetEditor
}: {
  capture: () => void
  draft: MemoryDraft
  setDraft: (draft: MemoryDraft) => void
  projects: string[]
  active: boolean
  busy: boolean
  conflict: boolean
  labels: Record<MemoryDraft['kind'], string>
  allProjects: string
  problem: ReactNode
  clearConflict: () => void
  save: () => void
  resetEditor: () => void
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const [discard, setDiscard] = useState(false)
  const [picker, setPicker] = useState(false)
  useCommanderDetailBack(
    active
      ? () => {
          if (busy) {
            return
          }
          if (picker) {
            setPicker(false)
          } else {
            setDiscard((value) => !value)
          }
        }
      : null
  )
  const patch = (
    values: Partial<Pick<MemoryDraft, 'kind' | 'projectId' | 'title' | 'body' | 'recurring'>>
  ) => setDraft(updateMemoryDraft(draft, values))
  const project = draft.projectId ?? ''
  const scope = t('commander.memoryProject', 'Project')
  const fields = draftHandoffFields(draft)
  const title = fields ? t('commander.handoffGoal', 'Goal') : t('commander.memoryTitle', 'Title')
  const body = t('commander.memoryMarkdown', 'Markdown')
  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      automaticallyAdjustKeyboardInsets
      contentContainerStyle={s.stack}
    >
      <Text accessibilityRole="header" style={s.heading}>
        {draft.recurring
          ? t('commander.ruleTitle', 'Recurring answer')
          : draft.expectedVersion
            ? fields
              ? t('commander.handoffEdit', 'Edit handoff')
              : t('commander.memoryEdit', 'Edit page')
            : fields
              ? t('commander.handoffNew', 'New handoff')
              : t('commander.memoryNew', 'New page')}
      </Text>
      {!fields && !draft.recurring && (
        <View style={s.row}>
          {(['note', 'guideline', 'decision'] as const).map((kind) => (
            <MemoryButton
              key={kind}
              selected={kind === draft.kind}
              disabled={busy || draft.expectedVersion > 0}
              label={labels[kind]}
              onPress={() => patch({ kind })}
            />
          ))}
        </View>
      )}
      <MemoryButton
        label={
          scope +
          ' · ' +
          (project ||
            (draft.recurring ? t('commander.ruleChooseProject', 'Choose a project') : allProjects))
        }
        disabled={busy || draft.expectedVersion > 0}
        onPress={() => setPicker(true)}
      />
      <PickerModal
        visible={active && picker}
        title={scope}
        searchable
        options={[
          ...(draft.recurring ? [] : [{ value: '', label: allProjects }]),
          ...projects.map((p) => ({ value: p, label: p }))
        ]}
        selected={project}
        onSelect={(p) => patch({ projectId: p || null })}
        onClose={() => setPicker(false)}
      />
      {fields && (
        <MemoryButton
          label={t('commander.handoffCapture', 'Use recent conversation')}
          disabled={busy || !!(draft.title.trim() && fields.progress.trim())}
          onPress={capture}
        />
      )}
      {draft.recurring ? (
        <PhoneRecurringAnswerFields
          fields={draft.recurring}
          busy={busy}
          onChange={(recurring) => patch({ recurring })}
        />
      ) : (
        <>
          <Text style={s.meta}>{title}</Text>
          <TextInput
            style={s.field}
            accessibilityLabel={title}
            value={draft.title}
            editable={!busy}
            maxLength={HANDOFF_GOAL_LIMIT}
            onChangeText={(value) => patch({ title: value })}
          />
          {fields ? (
            (['progress', 'nextStep'] as const).map((key) => {
              const label =
                key === 'progress'
                  ? t('commander.handoffProgress', 'Progress')
                  : t('commander.handoffNext', 'Next step')
              return (
                <View key={key}>
                  <Text style={s.meta}>{label}</Text>
                  <TextInput
                    accessibilityLabel={label}
                    multiline
                    style={[s.field, s.editor]}
                    value={fields[key]}
                    editable={!busy}
                    maxLength={HANDOFF_SECTION_LIMIT}
                    onChangeText={(value) =>
                      patch({ body: encodeHandoffBody({ ...fields, [key]: value }) })
                    }
                  />
                </View>
              )
            })
          ) : (
            <>
              <Text style={s.meta}>{body}</Text>
              <TextInput
                multiline
                style={[s.field, s.editor]}
                accessibilityLabel={body}
                value={draft.body}
                editable={!busy}
                onChangeText={(value) => patch({ body: value })}
              />
            </>
          )}
        </>
      )}
      {problem}
      {conflict && !draft.recurring && (
        <MemoryButton
          label={t('commander.memoryCopyDraft', 'Keep as a new page')}
          onPress={() => {
            const { pageId, requestId, expectedVersion } = memoryDraft()
            setDraft({
              ...draft,
              pageId: fields ? createHandoffPageId() : pageId,
              requestId,
              expectedVersion
            })
            clearConflict()
          }}
        />
      )}
      <View style={s.row}>
        <MemoryButton
          primary
          label={t('common.save', 'Save')}
          disabled={
            busy ||
            !draft.title.trim() ||
            conflict ||
            (!!draft.recurring && !validRecurringDraft(draft))
          }
          onPress={save}
        />
        <MemoryButton
          label={t('common.cancel', 'Cancel')}
          disabled={busy}
          onPress={() => setDiscard(true)}
        />
      </View>
      <ConfirmModal
        visible={active && discard}
        title={t('commander.memoryDiscard', 'Discard this draft?')}
        confirmLabel={t('commander.memoryDiscardAction', 'Discard draft')}
        destructive
        onCancel={() => setDiscard(false)}
        onConfirm={resetEditor}
      />
    </ScrollView>
  )
}
