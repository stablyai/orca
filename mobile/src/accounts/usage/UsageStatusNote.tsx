import { Text, View } from 'react-native'
import {
  getProviderUsageErrorMessage,
  getProviderUsageStatusLabel,
  type UsageStatusCopySource
} from '../../../../src/shared/agent-usage/status-copy/usage-error-copy'
import type { ProviderRateLimits } from '../accounts-snapshot'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { typography } from '../../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../../theme/themed-styles'
// The decoded snapshot leaves usageMetadata untyped; read only the strings the copy needs.
function readStatusCopySource(limits: ProviderRateLimits): UsageStatusCopySource {
  const metadata: unknown = limits.usageMetadata
  if (typeof metadata !== 'object' || metadata === null) {
    return { provider: limits.provider, error: limits.error }
  }
  const failureKind =
    'failureKind' in metadata && typeof metadata.failureKind === 'string'
      ? metadata.failureKind
      : undefined
  const credentialSource =
    'credentialSource' in metadata && typeof metadata.credentialSource === 'string'
      ? metadata.credentialSource
      : undefined
  return {
    provider: limits.provider,
    error: limits.error,
    usageMetadata: { failureKind, credentialSource }
  }
}

/** Why a provider's usage did not refresh, in desktop's words; a status, not an alarm. */
export function UsageStatusNote({ limits }: { limits: ProviderRateLimits }) {
  const styles = useThemedStyles(stylesSheet)
  const t = useMobileTranslation()
  if (!limits.error) {
    return null
  }
  // Desktop shows an unavailable provider's own reason as is.
  if (limits.status === 'unavailable') {
    return (
      <Text style={styles.message} numberOfLines={2}>
        {limits.error}
      </Text>
    )
  }
  const source = readStatusCopySource(limits)
  const label = getProviderUsageStatusLabel(source, t)
  const message = getProviderUsageErrorMessage(source, t)
  return (
    <View>
      <Text style={styles.label} numberOfLines={1}>
        {label}
      </Text>
      {message !== label ? (
        <Text style={styles.message} numberOfLines={3}>
          {message}
        </Text>
      ) : null}
    </View>
  )
}

const stylesSheet = themedStyleSheet((colors) => ({
  label: {
    fontSize: typography.metaSize,
    fontWeight: '500',
    color: colors.textSecondary
  },
  message: {
    fontSize: typography.metaSize,
    color: colors.textMuted
  }
}))
