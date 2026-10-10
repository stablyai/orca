import type { ReactNode } from 'react'
import { ActivityIndicator, Linking, Pressable, Text, View } from 'react-native'
import {
  Check,
  ExternalLink,
  KeyRound,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  X
} from 'lucide-react-native'
import { colors } from '../theme/mobile-theme'
import { voiceSettingsStyles as base } from './voice-settings-styles'
import { voiceCabinetStyles as cabinet } from './voice-cabinet-styles'
import { voiceProviderStyles as styles } from './voice-provider-styles'
import { speechProviderLabel } from '../dictation/speech-provider-presentation'
import type {
  MobileSpeechProvider,
  MobileSpeechProviderKeyTest
} from '../dictation/speech-provider-reply-schema'
import type { ProviderKeyAction } from './use-voice-provider-controller'

type Props = {
  provider: MobileSpeechProvider
  keyAction: ProviderKeyAction | null
  testResult: MobileSpeechProviderKeyTest | null
  onAddKey: () => void
  onTest: () => void
  onRemove: () => void
}

function maskedKeyHint(hint: string | null | undefined): string {
  const tail = hint?.replace(/^…/, '') ?? ''
  return `••••••••${tail}`
}

function KeyRow({
  icon,
  label,
  sublabel,
  destructive,
  disabled,
  trailing,
  testID,
  onPress
}: {
  icon: ReactNode
  label: string
  sublabel?: ReactNode
  destructive?: boolean
  disabled?: boolean
  trailing?: ReactNode
  testID: string
  onPress?: () => void
}) {
  return (
    <Pressable
      style={({ pressed }) => [base.row, pressed && onPress && base.rowPressed]}
      disabled={disabled || !onPress}
      onPress={onPress}
      accessibilityRole={onPress ? 'button' : undefined}
      testID={testID}
    >
      <View style={cabinet.iconTile}>{icon}</View>
      <View style={base.rowContent}>
        <Text style={[base.rowLabel, destructive && styles.destructiveLabel]}>{label}</Text>
        {sublabel}
      </View>
      {trailing}
    </Pressable>
  )
}

export function VoiceProviderKeySection(props: Props) {
  const { provider, keyAction, testResult, onAddKey, onTest, onRemove } = props
  const label = speechProviderLabel(provider)
  const busy = keyAction !== null
  if (!provider.keyConfigured) {
    return (
      <View style={[base.section, base.sectionTopGap]}>
        <KeyRow
          icon={<Plus size={17} color={colors.textPrimary} strokeWidth={2} />}
          label="Add API key"
          sublabel={<Text style={base.rowSublabel}>Paste a key to use {label} models.</Text>}
          testID="voice-provider-add-key"
          onPress={onAddKey}
        />
        {provider.keyUrl ? (
          <>
            <View style={base.separator} />
            <KeyRow
              icon={<ExternalLink size={16} color={colors.textPrimary} strokeWidth={2} />}
              label={`Get your ${label} API key`}
              sublabel={<Text style={base.rowSublabel}>Opens the {label} console.</Text>}
              testID="voice-provider-get-key"
              onPress={() => void Linking.openURL(provider.keyUrl ?? '')}
            />
          </>
        ) : null}
      </View>
    )
  }
  return (
    <View style={[base.section, base.sectionTopGap]}>
      <KeyRow
        icon={<KeyRound size={16} color={colors.textPrimary} strokeWidth={2} />}
        label="API key"
        sublabel={<Text style={styles.maskedKey}>{maskedKeyHint(provider.keyHint)}</Text>}
        trailing={
          <View style={cabinet.statusLine}>
            <View style={cabinet.statusDot} />
            <Text style={cabinet.statusText}>Connected</Text>
          </View>
        }
        testID="voice-provider-key"
      />
      <View style={base.separator} />
      <KeyRow
        icon={<ShieldCheck size={16} color={colors.textPrimary} strokeWidth={2} />}
        label="Test connection"
        sublabel={
          testResult && !testResult.ok ? (
            <Text style={styles.testFailure}>
              {testResult.message || `${label} refused the key.`}
            </Text>
          ) : null
        }
        disabled={busy}
        trailing={
          keyAction === 'testing' ? (
            <ActivityIndicator size="small" color={colors.textSecondary} />
          ) : testResult ? (
            <View style={cabinet.selectedTag}>
              {testResult.ok ? (
                <Check size={14} color={colors.statusGreen} strokeWidth={2.4} />
              ) : (
                <X size={14} color={colors.statusRed} strokeWidth={2.4} />
              )}
              <Text style={testResult.ok ? cabinet.selectedText : styles.testFailedTag}>
                {testResult.ok ? 'Key works' : 'Failed'}
              </Text>
            </View>
          ) : null
        }
        testID="voice-provider-test-key"
        onPress={onTest}
      />
      <View style={base.separator} />
      <KeyRow
        icon={<RefreshCw size={16} color={colors.textPrimary} strokeWidth={2} />}
        label="Replace key"
        disabled={busy}
        testID="voice-provider-replace-key"
        onPress={onAddKey}
      />
      <View style={base.separator} />
      <KeyRow
        icon={<Trash2 size={16} color={colors.statusRed} strokeWidth={2} />}
        label="Remove key"
        destructive
        disabled={busy}
        trailing={
          keyAction === 'removing' ? (
            <ActivityIndicator size="small" color={colors.statusRed} />
          ) : null
        }
        testID="voice-provider-remove-key"
        onPress={onRemove}
      />
    </View>
  )
}
