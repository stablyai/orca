import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View
} from 'react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'

export type MaestroAnnotationTone = 'decision' | 'warning' | 'blocked' | 'observation'

const TONES: Array<{ value: MaestroAnnotationTone; label: string; color: string }> = [
  { value: 'decision', label: 'Decision', color: colors.statusGreen },
  { value: 'warning', label: 'Warning', color: colors.statusAmber },
  { value: 'blocked', label: 'Blocked', color: colors.statusRed },
  { value: 'observation', label: 'Observation', color: colors.textMuted }
]

export function MobileMaestroAnnotationComposer({
  visible,
  text,
  tone,
  busy,
  onTextChange,
  onToneChange,
  onCancel,
  onCreate
}: {
  visible: boolean
  text: string
  tone: MaestroAnnotationTone
  busy: boolean
  onTextChange: (value: string) => void
  onToneChange: (value: MaestroAnnotationTone) => void
  onCancel: () => void
  onCreate: () => void
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.keyboardAvoider}
      >
        <View style={styles.scrim}>
          <View style={styles.sheet}>
            <Text style={styles.title}>New workspace note</Text>
            <Text style={styles.copy}>
              Creates a real content tab and projects it on the Canvas.
            </Text>
            <View style={styles.tones}>
              {TONES.map((item) => (
                <Pressable
                  key={item.value}
                  onPress={() => onToneChange(item.value)}
                  style={[styles.tone, tone === item.value && { borderColor: item.color }]}
                >
                  <View style={[styles.dot, { backgroundColor: item.color }]} />
                  <Text style={styles.toneText}>{item.label}</Text>
                </Pressable>
              ))}
            </View>
            <TextInput
              autoFocus
              multiline
              value={text}
              onChangeText={onTextChange}
              placeholder="Write a decision, warning, blocker, or observation…"
              placeholderTextColor={colors.textMuted}
              style={styles.input}
            />
            <View style={styles.actions}>
              <Pressable onPress={onCancel} style={styles.cancel}>
                <Text style={styles.cancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                disabled={busy || text.trim().length === 0}
                onPress={onCreate}
                style={[styles.create, (busy || text.trim().length === 0) && styles.disabled]}
              >
                <Text style={styles.createText}>{busy ? 'Creating…' : 'Create note'}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  )
}

const styles = StyleSheet.create({
  keyboardAvoider: { flex: 1 },
  scrim: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.62)' },
  sheet: {
    padding: spacing.lg,
    paddingBottom: spacing.xl,
    borderTopWidth: 1,
    borderColor: colors.borderSubtle,
    borderTopLeftRadius: radii.card,
    borderTopRightRadius: radii.card,
    backgroundColor: colors.bgPanel
  },
  title: { color: colors.textPrimary, fontSize: typography.titleSize, fontWeight: '700' },
  copy: { marginTop: spacing.xs, color: colors.textSecondary, fontSize: typography.metaSize },
  tones: { marginTop: spacing.lg, flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  tone: {
    minHeight: 44,
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.button,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  toneText: { color: colors.textPrimary, fontSize: typography.metaSize, fontWeight: '600' },
  input: {
    minHeight: 132,
    marginTop: spacing.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.input,
    color: colors.textPrimary,
    backgroundColor: colors.editorSurface,
    textAlignVertical: 'top',
    fontSize: typography.bodySize
  },
  actions: {
    marginTop: spacing.md,
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.sm
  },
  cancel: {
    minHeight: 44,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
    justifyContent: 'center'
  },
  cancelText: { color: colors.textSecondary, fontWeight: '600' },
  create: {
    minHeight: 44,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.button,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceBright
  },
  createText: { color: colors.bgBase, fontWeight: '700' },
  disabled: { opacity: 0.45 }
})
