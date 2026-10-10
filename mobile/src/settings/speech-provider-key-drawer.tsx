import { useState } from 'react'
import {
  ActivityIndicator,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View
} from 'react-native'
import { ExternalLink, Lock } from 'lucide-react-native'
import { BottomDrawer } from '../components/BottomDrawer'
import { SpeechProviderLogo } from '../components/SpeechProviderLogo'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { TEXT_INPUT_FONT_SIZE } from '../platform/text-input-font-size'
import { speechProviderLabel } from '../dictation/speech-provider-presentation'
import type { MobileSpeechProvider } from '../dictation/speech-provider-reply-schema'

type Props = {
  visible: boolean
  provider: MobileSpeechProvider
  replacing: boolean
  saving: boolean
  error: string | null
  onClose: () => void
  onSave: (apiKey: string) => void
  onDraftChange: () => void
}

/** Write-only key entry modelled on the Linear connect sheet; the draft is dropped on close. */
export function SpeechProviderKeyDrawer({
  visible,
  provider,
  replacing,
  saving,
  error,
  onClose,
  onSave,
  onDraftChange
}: Props) {
  const [draft, setDraft] = useState('')
  const [draftVisible, setDraftVisible] = useState(visible)
  // Why: drop the typed key as soon as the drawer hides, before any re-open can show it.
  if (visible !== draftVisible) {
    setDraftVisible(visible)
    if (!visible) {
      setDraft('')
    }
  }
  const label = speechProviderLabel(provider)
  const canSave = draft.trim().length > 0 && !saving
  const save = () => {
    if (canSave) {
      onSave(draft.trim())
    }
  }
  return (
    <BottomDrawer
      visible={visible}
      onClose={() => {
        if (!saving) {
          onClose()
        }
      }}
    >
      <View style={styles.header}>
        <View style={styles.titleRow}>
          <SpeechProviderLogo providerId={provider.id} size={22} />
          <Text style={styles.title}>
            {replacing ? `Replace ${label} key` : `Connect ${label}`}
          </Text>
        </View>
        <Text style={styles.subtitle}>
          Paste an API key. Orca checks it with {label} before saving it on your desktop.
        </Text>
      </View>
      <View style={styles.form}>
        <Text style={styles.fieldLabel}>API key</Text>
        <TextInput
          style={styles.input}
          value={draft}
          onChangeText={(next) => {
            setDraft(next)
            onDraftChange()
          }}
          placeholder={provider.keyPlaceholder ?? 'API key'}
          placeholderTextColor={colors.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
          spellCheck={false}
          secureTextEntry
          accessibilityLabel={`${label} API key`}
          editable={!saving}
          returnKeyType="done"
          onSubmitEditing={save}
          testID="speech-provider-key-input"
        />
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {provider.keyUrl ? (
          <Pressable
            style={styles.link}
            accessibilityRole="link"
            onPress={() => void Linking.openURL(provider.keyUrl ?? '')}
          >
            <ExternalLink size={13} color={colors.textSecondary} />
            <Text style={styles.linkText}>Get your {label} API key</Text>
          </Pressable>
        ) : null}
        <View style={styles.hintRow}>
          <Lock size={13} color={colors.textMuted} />
          <Text style={styles.hintText}>
            Stored encrypted on your desktop. Never sent back to this phone.
          </Text>
        </View>
        <Pressable
          style={[styles.saveButton, !canSave && styles.saveButtonDisabled]}
          disabled={!canSave}
          onPress={save}
          accessibilityRole="button"
          accessibilityLabel="Verify and save API key"
          testID="speech-provider-key-save"
        >
          {saving ? (
            <ActivityIndicator size="small" color={colors.bgBase} />
          ) : (
            <Text style={styles.saveButtonText}>Verify & save</Text>
          )}
        </Pressable>
      </View>
    </BottomDrawer>
  )
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: spacing.xs, marginBottom: spacing.md },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  title: {
    flex: 1,
    minWidth: 0,
    fontSize: 15,
    fontWeight: '700',
    color: colors.textPrimary,
    lineHeight: 20
  },
  subtitle: { fontSize: typography.metaSize, color: colors.textMuted, marginTop: spacing.xs },
  form: { gap: spacing.sm },
  fieldLabel: { fontSize: typography.metaSize, fontWeight: '600', color: colors.textSecondary },
  input: {
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bgPanel,
    borderRadius: radii.input,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    color: colors.textPrimary,
    fontSize: TEXT_INPUT_FONT_SIZE,
    fontFamily: typography.monoFamily
  },
  error: { color: colors.statusRed, fontSize: 13, lineHeight: 18 },
  link: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    alignSelf: 'flex-start',
    paddingVertical: spacing.xs
  },
  linkText: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    textDecorationLine: 'underline'
  },
  hintRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.xs },
  hintText: { flex: 1, color: colors.textMuted, fontSize: 11, lineHeight: 16 },
  saveButton: {
    marginTop: spacing.sm,
    backgroundColor: colors.textPrimary,
    borderRadius: radii.button,
    paddingVertical: spacing.sm + 2,
    alignItems: 'center'
  },
  saveButtonDisabled: { opacity: 0.5 },
  saveButtonText: { color: colors.bgBase, fontSize: typography.bodySize, fontWeight: '700' }
})
