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
  const [draft, setDraft] = useState(() => initialAgentSessionFormDraft(form))
  const [error, setError] = useState<string | null>(null)
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
      setError(cause instanceof Error ? cause.message : 'Check the form values.')
    }
  }
  return (
    <ScrollView style={styles.form} keyboardShouldPersistTaps="handled">
      {form.fields.map((field) => {
        const title = field.schema.title ?? field.name
        const value = draft.get(field.name)
        const choices = agentSessionFormChoices(field)
        return (
          <View key={field.name} style={styles.field}>
            <Text style={styles.text}>
              {title}
              {field.required ? '' : ' (Optional)'}
            </Text>
            {field.schema.description ? (
              <Text style={styles.text}>{field.schema.description}</Text>
            ) : null}
            {!field.required && value !== undefined ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Clear ${title}`}
                disabled={disabled}
                onPress={() => edit(field.name, undefined)}
              >
                <Text style={styles.text}>Clear</Text>
              </Pressable>
            ) : null}
            {choices.length ? (
              choices.map((choice, index) => (
                <Pressable
                  key={index}
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
      {error ? (
        <Text accessibilityRole="alert" style={styles.text}>
          {error}
        </Text>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Submit"
        disabled={disabled || submitDisabled}
        onPress={submit}
        style={styles.control}
      >
        <Text style={styles.text}>Submit</Text>
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
