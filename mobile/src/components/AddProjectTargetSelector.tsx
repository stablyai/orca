import { useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'

export type AddProjectTarget = { id: string | null; label: string; connected?: boolean; connectionStatus?: string }

export function AddProjectTargetSelector(props: {
  busy: boolean
  targets: readonly AddProjectTarget[]
  selectedId: string | null
  onSelect: (id: string | null) => void
}) {
  const { busy, targets, selectedId, onSelect } = props
  const [open, setOpen] = useState(false)
  if (targets.length === 0) {
    return null
  }
  const selected = targets.find((target) => target.id === selectedId)?.label ?? 'This host'
  return (
    <View style={styles.section}>
      <Text style={styles.label}>Run on</Text>
      <Pressable
        style={styles.button}
        onPress={() => setOpen((current) => !current)}
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel={`Run on ${selected}`}
      >
        <Text style={styles.buttonText} numberOfLines={1}>{selected}</Text>
      </Pressable>
      {open ? <ScrollView style={styles.options} accessibilityRole="list">
        {targets.map((target) => (
          <Pressable
            key={target.id ?? 'local'}
            style={styles.option}
            onPress={() => { onSelect(target.id); setOpen(false) }}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel={`Select ${target.label}`}
            accessibilityState={{ selected: target.id === selectedId, disabled: busy }}
          >
            <Text style={styles.optionText}>
              {target.label}{target.id && target.connected === false ? ' · Not connected' : ''}
            </Text>
          </Pressable>
        ))}
      </ScrollView> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  section: { marginBottom: spacing.md },
  label: { fontSize: typography.metaSize, color: colors.textMuted, marginBottom: spacing.xs },
  button: {
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.input,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.bgPanel
  },
  buttonText: { color: colors.textPrimary, fontSize: typography.bodySize },
  options: {
    marginTop: spacing.xs,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.input,
    backgroundColor: colors.bgPanel,
    maxHeight: 180
  },
  option: { paddingVertical: spacing.sm, paddingHorizontal: spacing.md },
  optionText: { color: colors.textPrimary, fontSize: typography.bodySize }
})
