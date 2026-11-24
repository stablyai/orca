import { useRef, useState } from 'react'
import { Text, TextInput, View } from 'react-native'
import { createNonSecureContextUuid } from '../../../src/shared/identifiers/non-secure-context-uuid'
import {
  recurringQuestionLimit,
  recurringAnswerLimit
} from '../../../src/shared/commander/recurring-answer'
import { ConfirmModal } from '../components/sheets/ConfirmModal'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { MemoryButton, s } from './phone-memory-controls'

type Fields = { question: string; answer: string }

export function PhoneRecurringAnswerFields({
  fields,
  busy,
  onChange
}: {
  fields: Fields
  busy: boolean
  onChange: (next: Fields) => void
}) {
  const t = useMobileTranslation()
  return (
    <>
      <Text style={s.meta}>
        {t(
          'commander.ruleHint',
          'Commander may use this answer when an Orca question matches exactly in this project.'
        )}
      </Text>
      {(['question', 'answer'] as const).map((key) => {
        const label =
          key === 'question'
            ? t('commander.ruleQuestion', 'Exact question')
            : t('commander.ruleAnswer', 'Answer')
        return (
          <View key={key}>
            <Text style={s.meta}>{label}</Text>
            <TextInput
              accessibilityLabel={label}
              multiline
              style={s.field}
              editable={!busy}
              maxLength={key === 'question' ? recurringQuestionLimit : recurringAnswerLimit}
              value={fields[key]}
              onChangeText={(value) => onChange({ ...fields, [key]: value })}
            />
          </View>
        )
      })}
    </>
  )
}

export function PhoneRecurringAnswer({
  fields,
  busy,
  remove
}: {
  fields: Fields
  busy: boolean
  remove?: (requestId: string) => void
}) {
  const t = useMobileTranslation()
  const [confirm, setConfirm] = useState(false)
  const request = useRef<string | null>(null)
  return (
    <>
      <Text style={s.meta}>{t('commander.ruleQuestion', 'Exact question')}</Text>
      <Text selectable style={s.title}>
        {fields.question}
      </Text>
      <Text style={s.meta}>{t('commander.ruleAnswer', 'Answer')}</Text>
      <Text selectable style={s.body}>
        {fields.answer}
      </Text>
      {remove && (
        <>
          <MemoryButton
            disabled={busy}
            label={t('commander.ruleRemove', 'Remove recurring answer')}
            onPress={() => setConfirm(true)}
          />
          <ConfirmModal
            visible={confirm}
            title={t('commander.ruleConfirm', 'Stop reusing this answer for this project?')}
            confirmLabel={t('commander.ruleRemove', 'Remove recurring answer')}
            destructive
            onConfirm={() => {
              request.current ??= createNonSecureContextUuid()
              remove(request.current)
            }}
            onCancel={() => setConfirm(false)}
          />
        </>
      )}
    </>
  )
}
