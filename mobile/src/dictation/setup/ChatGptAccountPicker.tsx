import { Text, View } from 'react-native'
import { ListGroup, ListRow } from '../../components/list/ListGroup'
import { colors, spacing, typography } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { chatgptSubscriptionLoginGuidance, type MobileSpeechSetup } from '../mobile-dictation-setup'

export function ChatGptAccountPicker({
  setup,
  disabled,
  onChange
}: {
  setup: MobileSpeechSetup
  disabled: boolean
  onChange: (id: string | null) => void
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const accounts = setup.chatGptAccounts
  const selected = setup.chatGptAccountId ?? null
  const supported = accounts !== undefined
  return (
    <View style={styles.section}>
      <Text style={styles.label}>
        {t('dictation.setup.chatgptAccount', 'ChatGPT dictation account')}
      </Text>
      {!supported ? (
        <Text style={styles.detail}>
          {t(
            'dictation.setup.chatgptAccountsUpdateRequired',
            'Update Orca on the transcription host to choose a ChatGPT dictation account here. Manage sign-ins in that host’s Settings → AI Provider Accounts.'
          )}
        </Text>
      ) : (
        <>
          {selected && !accounts.some((account) => account.id === selected) ? (
            <Text style={styles.detail}>
              {t('dictation.setup.chatgptAccountUnavailable', '{{account}} (unavailable)', {
                account: selected
              })}
            </Text>
          ) : null}
          <ListGroup>
            {[
              { id: null, label: t('dictation.setup.chatgptNoAccount', 'No account selected') },
              ...accounts
            ].map((account) => (
              <ListRow
                key={account.id ?? 'unconfigured'}
                title={account.label}
                selected={selected === account.id}
                disabled={disabled}
                onPress={() => onChange(account.id)}
              />
            ))}
          </ListGroup>
          <Text style={styles.detail}>{chatgptSubscriptionLoginGuidance()}</Text>
        </>
      )}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  section: { gap: spacing.sm, paddingVertical: spacing.sm },
  label: { color: colors.textPrimary, fontSize: typography.bodySize, fontWeight: '600' },
  detail: { color: colors.textMuted, fontSize: typography.metaSize }
}))
