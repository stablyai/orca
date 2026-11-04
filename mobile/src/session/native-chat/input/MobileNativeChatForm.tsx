import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import {
  agentSessionFormBooleanLabels,
  agentSessionFormErrorMessage
} from '../../../../../src/shared/agent-session-form-copy'
import { useState, type ReactNode } from 'react'
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native'
import { TEXT_INPUT_FONT_SIZE } from '../../../platform/text-input-font-size'
import { colors, spacing } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import {
  agentSessionFormChoices,
  checkAgentSessionFormDraft,
  initialAgentSessionFormDraft,
  type AgentSessionForm,
  type AgentSessionFormContent
} from '../../../../../src/shared/agent-session-form'

export type MobileNativeChatFormSubmit = { disabled: boolean; onPress: () => Promise<void> }

/** Fields scroll; Submit renders in the card's pinned action row through `renderActions`. */
export function MobileNativeChatForm({
  form,
  disabled,
  submitDisabled = false,
  onSubmit,
  renderActions
}: {
  form: AgentSessionForm
  submitDisabled?: boolean
  disabled: boolean
  onSubmit: (content: AgentSessionFormContent) => Promise<boolean>
  renderActions: (submit: MobileNativeChatFormSubmit) => ReactNode
}): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const [draft, setDraft] = useState(() => initialAgentSessionFormDraft(form))
  const [errors, setErrors] = useState<{
    fields: ReadonlyMap<string, unknown>
    form: unknown
  }>({ fields: new Map(), form: null })
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
    setErrors((current) => {
      const fields = new Map(current.fields)
      fields.delete(name)
      return { fields, form: null }
    })
  }
  const submit = async (): Promise<void> => {
    if (disabled || submitDisabled) {
      return
    }
    const checked = checkAgentSessionFormDraft(form, draft)
    if (!('content' in checked)) {
      setErrors({ fields: checked.fieldErrors, form: checked.formError })
      return
    }
    setErrors({ fields: new Map(), form: null })
    try {
      await onSubmit(checked.content)
    } catch (cause) {
      setErrors({ fields: new Map(), form: cause })
    }
  }
  return (
    <>
      <ScrollView style={styles.form} keyboardShouldPersistTaps="handled">
        {form.fields.map((field) => {
          const title = field.schema.title ?? field.name
          const value = draft.get(field.name)
          const choices = agentSessionFormChoices(field, agentSessionFormBooleanLabels(t))
          const error = errors.fields.get(field.name)
          return (
            <View key={field.name} style={styles.field}>
              <Text style={styles.text}>
                {title}
                {field.required
                  ? ''
                  : ` (${t('components.native-chat.form.optional', 'Optional')})`}
              </Text>
              {field.schema.description ? (
                <Text style={styles.text}>{field.schema.description}</Text>
              ) : null}
              {!field.required && value !== undefined ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t(
                    'components.native-chat.form.clearField',
                    'Clear {{field}}',
                    { field: title }
                  )}
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
                  style={[styles.control, styles.text, styles.input]}
                  onChangeText={(text) => edit(field.name, text)}
                />
              )}
              {errors.fields.has(field.name) ? (
                <Text accessibilityRole="alert" style={styles.error}>
                  {agentSessionFormErrorMessage(error, t)}
                </Text>
              ) : null}
            </View>
          )
        })}
        {errors.form !== null ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {agentSessionFormErrorMessage(errors.form, t)}
          </Text>
        ) : null}
      </ScrollView>
      {renderActions({ disabled: disabled || submitDisabled, onPress: submit })}
    </>
  )
}

const styles = themedStyleSheet(() => ({
  form: { flexShrink: 1 },
  field: { gap: spacing.sm, marginBottom: spacing.md },
  control: { minHeight: 44, padding: spacing.sm, borderWidth: 1, borderColor: colors.borderSubtle },
  text: { color: colors.textPrimary },
  // Below 16px iOS zooms the hosted page on focus and never zooms back.
  input: { fontSize: TEXT_INPUT_FONT_SIZE },
  error: { color: colors.statusRed }
}))
