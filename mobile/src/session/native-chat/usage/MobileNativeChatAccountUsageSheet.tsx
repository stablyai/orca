// `/usage` on the phone: the desktop card's account and usage windows for this chat's Codex account.
import { useEffect, useState } from 'react'
import { ActivityIndicator, Text, View } from 'react-native'
import type { AgentSessionAccountUsage } from '../../../../../src/shared/agent-session/lifecycle/accounts/agent-session-account-usage'
import { agentSessionUsageAccountLabel } from '../../../../../src/shared/agent-session/lifecycle/accounts/agent-session-usage-account-label'
import { BottomDrawer } from '../../../components/bottom-drawer/BottomDrawer'
import { SheetHeader } from '../../../components/nav-bar/SheetHeader'
import { ListRow } from '../../../components/list/ListGroup'
import { ProviderUsageWindows } from '../../../accounts/ProviderUsageWindows'
import { UsageStatusNote } from '../../../accounts/usage/UsageStatusNote'
import { useNow } from '../../../hooks/use-now'
import type { Translate } from '../../../i18n/mobile-i18n'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { colors, spacing, typography } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import type { MobileStructuredAccountUsage } from './use-mobile-structured-account-usage'

function unavailableMessage(
  result: Exclude<AgentSessionAccountUsage, { status: 'ok' }>,
  t: Translate
): string {
  if (result.status === 'failed') {
    return t('components.native-chat.usage.failed', 'Codex usage couldn’t be loaded. Try again.')
  }
  return result.reason === 'codexVersion'
    ? t(
        'components.native-chat.usage.codexVersion',
        'This Codex version doesn’t report usage. Update Codex.'
      )
    : t(
        'components.native-chat.usage.apiKeyAuth',
        'Codex usage isn’t available with an API key. Sign in to Codex with a ChatGPT account to view usage.'
      )
}

export function MobileNativeChatAccountUsageSheet({
  usage,
  open,
  onClose
}: {
  usage: MobileStructuredAccountUsage
  open: boolean
  onClose: () => void
}): React.JSX.Element {
  return (
    <BottomDrawer visible={open} onClose={onClose}>
      <AccountUsageBody usage={usage} onClose={onClose} />
    </BottomDrawer>
  )
}

/** Mounted only while the sheet shows, so each opening reads afresh and a closed sheet ticks no clock. */
function AccountUsageBody({
  usage,
  onClose
}: {
  usage: MobileStructuredAccountUsage
  onClose: () => void
}): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const now = useNow()
  const [result, setResult] = useState<AgentSessionAccountUsage | null>(null)
  const [reads, setReads] = useState(0)
  useEffect(() => {
    let current = true
    setResult(null)
    void usage.read().then((read) => current && setResult(read))
    return () => {
      current = false
    }
  }, [usage, reads])
  return (
    <>
      <SheetHeader
        title={t('components.native-chat.usage.title', 'Codex usage')}
        onClose={onClose}
      />
      <View style={styles.body}>
        {result === null ? (
          <View style={styles.loading}>
            <ActivityIndicator size="small" color={colors.textMuted} />
            <Text style={styles.muted}>
              {t('components.native-chat.usage.loading', 'Loading Codex usage…')}
            </Text>
          </View>
        ) : result.status === 'ok' ? (
          <>
            <Text style={styles.muted}>
              {t('components.native-chat.usage.account', 'Account used by this chat')}
            </Text>
            <Text style={styles.account} numberOfLines={1}>
              {agentSessionUsageAccountLabel(result.account, t)}
            </Text>
            <ProviderUsageWindows limits={result.rateLimits} now={now} />
            <UsageStatusNote limits={result.rateLimits} />
          </>
        ) : (
          <Text style={styles.message}>{unavailableMessage(result, t)}</Text>
        )}
      </View>
      {result?.status === 'failed' ? (
        <ListRow
          title={t('components.native-chat.usage.retry', 'Retry')}
          onPress={() => setReads((count) => count + 1)}
        />
      ) : null}
    </>
  )
}

const styles = themedStyleSheet(() => ({
  body: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.lg,
    gap: spacing.sm
  },
  loading: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: spacing.sm
  },
  muted: {
    fontSize: typography.metaSize,
    color: colors.textMuted
  },
  account: {
    fontSize: typography.bodySize,
    fontWeight: '500' as const,
    color: colors.textPrimary
  },
  message: {
    fontSize: typography.bodySize,
    color: colors.textSecondary
  }
}))
