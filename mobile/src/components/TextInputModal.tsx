import { useState, useEffect } from 'react'
import { View, Text, TextInput, Pressable, StyleSheet, Platform } from 'react-native'
import { colors, spacing, radii, typography } from '../theme/mobile-theme'
import { BottomDrawer } from './BottomDrawer'

type Props = {
  visible: boolean
  title: string
  message?: string
  defaultValue?: string
  placeholder?: string
  onSubmit: (value: string) => void
  onCancel: () => void
}

export function TextInputModal({
  visible,
  title,
  message,
  defaultValue = '',
  placeholder,
  onSubmit,
  onCancel
}: Props) {
  const [value, setValue] = useState(defaultValue)

  useEffect(() => {
    if (visible) setValue(defaultValue)
  }, [visible, defaultValue])

  function handleSubmit() {
    if (value.trim()) {
      onSubmit(value.trim())
    }
  }

  return (
    <BottomDrawer visible={visible} onClose={onCancel}>
      <View style={styles.header}>
        <Text style={styles.title}>{title}</Text>
        {message ? <Text style={styles.message}>{message}</Text> : null}
      </View>

      <TextInput
        style={styles.input}
        value={value}
        onChangeText={setValue}
        placeholder={placeholder}
        placeholderTextColor={colors.textMuted}
        autoFocus
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="done"
        onSubmitEditing={handleSubmit}
        selectionColor={colors.accentBlue}
      />

      <View style={styles.actions}>
        <Pressable
          style={({ pressed }) => [styles.cancelButton, pressed && styles.buttonPressed]}
          onPress={onCancel}
        >
          <Text style={styles.cancelText}>Cancel</Text>
        </Pressable>
        <Pressable
          style={({ pressed }) => [
            styles.submitButton,
            pressed && styles.buttonPressed,
            !value.trim() && styles.submitButtonDisabled
          ]}
          disabled={!value.trim()}
          onPress={handleSubmit}
        >
          <Text style={styles.submitText}>Save</Text>
        </Pressable>
      </View>
    </BottomDrawer>
  )
}

const styles = StyleSheet.create({
  header: {
    paddingHorizontal: spacing.xs,
    paddingBottom: spacing.sm
  },
  title: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.textPrimary
  },
  message: {
    fontSize: 13,
    color: colors.textMuted,
    marginTop: 2
  },
  // Why: matches NewWorktreeModal's input — bgRaised on the modal
  // background reads as a tappable surface (brighter than the wrapper)
  // rather than a recessed pit (darker than the wrapper, which is what
  // bgBase looked like inside a bgPanel group).
  input: {
    backgroundColor: colors.bgRaised,
    color: colors.textPrimary,
    borderRadius: radii.input,
    paddingHorizontal: spacing.md,
    paddingVertical: Platform.OS === 'ios' ? spacing.sm + 2 : spacing.sm,
    fontSize: typography.bodySize,
    borderWidth: 1,
    borderColor: colors.borderSubtle
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.sm,
    marginTop: spacing.md
  },
  cancelButton: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radii.button
  },
  submitButton: {
    backgroundColor: colors.textPrimary,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radii.button
  },
  buttonPressed: {
    opacity: 0.7
  },
  submitButtonDisabled: {
    opacity: 0.4
  },
  cancelText: {
    color: colors.textSecondary,
    fontSize: typography.bodySize,
    fontWeight: '500'
  },
  submitText: {
    color: colors.bgBase,
    fontSize: typography.bodySize,
    fontWeight: '600'
  }
})
