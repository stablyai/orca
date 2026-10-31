import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import {
  agentSessionFormBooleanLabels,
  agentSessionFormErrorMessage
} from '../../../../../src/shared/agent-session-form-copy'
import { useState } from 'react'
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native'
import { colors, spacing } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import {
  agentSessionFormChoices,
  agentSessionFormDraftContent,
  initialAgentSessionFormDraft,
  type AgentSessionForm,
  type AgentSessionFormContent
} from '../../../../../src/shared/agent-session-form'

export function MobileNativeChatForm({
  form,
  disabled,
  submitDisabled = false,
  onSubmit
}: {
  form: AgentSessionForm
  submitDisabled?: boolean
  disabled: boolean
  onSubmit: (content: AgentSessionFormContent) => Promise<boolean>
}): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const [draft, setDraft] = useState(() => initialAgentSessionFormDraft(form))
  const [error, setError] = useState<unknown>(null)
  const edit = (name: string, value: string | boolean | undefined): void => {
    setDraft((current) => {
      const next = new Map(current)
      if (value === undefined) {
        next.delete(name)
      } else {
        next.set(name, value)
      }
      return next
    })
    setError(null)
  }
  const submit = async (): Promise<void> => {
    if (disabled || submitDisabled) {
      return
    }
    try {
      await onSubmit(agentSessionFormDraftContent(form, draft))
    } catch (cause) {
      setError(cause)
    }
  }
  return (
    <ScrollView style={styles.form} keyboardShouldPersistTaps="handled">
      {form.fields.map((field) => {
        const title = field.schema.title ?? field.name
        const value = draft.get(field.name)
        const choices = agentSessionFormChoices(field, agentSessionFormBooleanLabels(t))
        return (
          <View key={field.name} style={styles.field}>
            <Text style={styles.text}>
              {title}
              {field.required ? '' : ` (${t('components.native-chat.form.optional', 'Optional')})`}
            </Text>
            {field.schema.description ? (
              <Text style={styles.text}>{field.schema.description}</Text>
            ) : null}
            {!field.required && value !== undefined ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('components.native-chat.form.clearField', 'Clear {{field}}', {
                  field: title
                })}
                disabled={disabled}
                onPress={() => edit(field.name, undefined)}
              >
                <Text style={styles.text}>{t('components.native-chat.form.clear', 'Clear')}</Text>
              </Pressable>
            ) : null}
            {choices.length ? (
              choices.map((choice) => (
                <Pressable
                  key={String(choice.value)}
                  accessibilityRole="radio"
                  accessibilityLabel={`${title}: ${choice.label}`}
                  accessibilityState={{ checked: value === choice.value, disabled }}
                  disabled={disabled}
                  onPress={() => edit(field.name, choice.value)}
                  style={styles.control}
                >
                  <Text style={styles.text}>
                    {value === choice.value ? '● ' : '○ '}
                    {choice.label}
                  </Text>
                </Pressable>
              ))
            ) : (
              <TextInput
                accessibilityLabel={title}
                value={typeof value === 'string' ? value : ''}
                editable={!disabled}
                style={[styles.control, styles.text]}
                onChangeText={(text) => edit(field.name, text)}
              />
            )}
          </View>
        )
      })}
      {error !== null ? (
        <Text accessibilityRole="alert" style={styles.text}>
          {agentSessionFormErrorMessage(error, t)}
        </Text>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('chat.question.submit', 'Submit')}
        disabled={disabled || submitDisabled}
        onPress={submit}
        style={styles.control}
      >
        <Text style={styles.text}>{t('chat.question.submit', 'Submit')}</Text>
      </Pressable>
    </ScrollView>
  )
}

const styles = themedStyleSheet(() => ({
  form: { flexShrink: 1 },
  field: { gap: spacing.sm, marginBottom: spacing.md },
  control: { minHeight: 44, padding: spacing.sm, borderWidth: 1, borderColor: colors.borderSubtle },
  text: { color: colors.textPrimary }
}))
