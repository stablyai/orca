import { useCallback, useEffect, useState } from 'react'
import { Pressable, Text, TextInput, View } from 'react-native'
import { Mic } from 'lucide-react-native'
import { OrcaSiri } from '../../modules/orca-siri/src/index'
import { ListGroup, ListRow } from '../components/list/ListGroup'
import { troubleshootScreenStyles as styles } from '../diagnostics/troubleshoot-screen-styles'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'

const inputStyles = themedStyleSheet(() => ({
  input: {
    backgroundColor: colors.bgRaised,
    borderRadius: radii.control,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.md,
    fontSize: typography.bodySize,
    color: colors.textPrimary
  }
}))

function SiriButton({ label, onPress }: { label: string; onPress: () => void }) {
  useMobileColorScheme()
  return (
    <Pressable
      style={({ pressed }) => [styles.diagnosticButton, pressed && styles.diagnosticButtonPressed]}
      onPress={onPress}
    >
      <Mic size={16} color={colors.textPrimary} />
      <Text style={styles.diagnosticButtonLabel}>{label}</Text>
    </Pressable>
  )
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ORCA_SIRI builds only: stores the Mac bridge URL and Siri token in the keychain for the App Intents.
export function SiriSetupRow() {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const [configuredUrl, setConfiguredUrl] = useState<string | null>(null)
  const [url, setUrl] = useState('')
  const [token, setToken] = useState('')
  const [status, setStatus] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const configuration = await OrcaSiri?.getConfiguration().catch(() => null)
    setConfiguredUrl(configuration?.configured ? configuration.url : null)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const native = OrcaSiri
  if (!native) {
    return (
      <Text style={styles.checkDetail}>
        {t('siri.nativeMissing', 'Siri module missing from this build.')}
      </Text>
    )
  }

  const test = async () => {
    setStatus(t('siri.testing', 'Testing…'))
    const result = await native.testConnection()
    setStatus(
      result.ok
        ? t('siri.testOk', '{{ms}} ms. Siri would say: “{{speech}}”', {
            ms: result.ms,
            speech: result.speech
          })
        : t('siri.testFailed', 'Failed after {{ms}} ms: {{message}}', {
            ms: result.ms,
            message: result.error
          })
    )
  }

  const save = async () => {
    try {
      await native.configure(url, token)
      setToken('')
      await refresh()
      await test()
    } catch (error) {
      setStatus(describe(error))
    }
  }

  const clear = async () => {
    await native.clearConfiguration()
    setStatus(null)
    await refresh()
  }

  return (
    <View>
      <ListGroup style={styles.group}>
        <ListRow
          key="bridge"
          title={t('siri.bridge', 'Siri bridge')}
          value={configuredUrl ?? t('siri.notSet', 'Not set')}
        />
      </ListGroup>
      <TextInput
        style={inputStyles.input}
        value={url}
        onChangeText={setUrl}
        placeholder={t('siri.urlPlaceholder', 'https://your-mac.ts.net:8443')}
        placeholderTextColor={colors.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
      />
      <TextInput
        style={inputStyles.input}
        value={token}
        onChangeText={setToken}
        placeholder={t('siri.tokenPlaceholder', 'Siri token (~/.orca/siri-bridge-token)')}
        placeholderTextColor={colors.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry
      />
      <SiriButton label={t('siri.save', 'Save and test')} onPress={() => void save()} />
      {configuredUrl ? (
        <>
          <SiriButton label={t('siri.test', 'Test Siri connection')} onPress={() => void test()} />
          <SiriButton label={t('siri.clear', 'Remove Siri bridge')} onPress={() => void clear()} />
        </>
      ) : null}
      {status ? (
        <Text style={styles.checkDetail} selectable>
          {status}
        </Text>
      ) : null}
    </View>
  )
}
