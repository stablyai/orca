import { useState } from 'react'
import { View, Text } from 'react-native'
import { Globe } from 'lucide-react-native'
import Svg, { Path } from 'react-native-svg'
import { OrcaLogo } from '../components/OrcaLogo'
import { LIST_LEADING_INSET, ListRow } from '../components/list/ListGroup'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { SettingsScreen, SettingsSection } from './settings-screen-frame'

function GithubIcon({ size = 16, color = colors.textSecondary }) {
  useMobileColorScheme()
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill={color}>
      <Path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
    </Svg>
  )
}

function XIcon({ size = 16, color = colors.textSecondary }) {
  useMobileColorScheme()
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill={color}>
      <Path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </Svg>
  )
}

export default function AboutScreen({
  onBack,
  openExternal,
  versionLabel
}: {
  onBack: () => void
  openExternal: (url: string) => Promise<unknown>
  versionLabel: string
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const [error, setError] = useState(false)
  const openLink = (url: string) => {
    setError(false)
    void openExternal(url).catch(() => setError(true))
  }

  return (
    <SettingsScreen title={t('settings.aboutScreen.title', 'About')} onBack={onBack}>
      <View style={styles.brand}>
        <OrcaLogo size={28} />
        <Text style={styles.brandName}>Orca</Text>
        <Text style={styles.brandSub}>
          {t('settings.aboutScreen.tagline', 'Open-source agent IDE for 100x builders')}
        </Text>
      </View>

      <SettingsSection first separatorInset={LIST_LEADING_INSET}>
        <ListRow
          key="website"
          title="onOrca.dev"
          leading={<Globe size={18} color={colors.textSecondary} />}
          accessibilityLabel={t('settings.aboutScreen.website', 'Orca website')}
          onPress={() => openLink('https://onOrca.dev')}
        />
        <ListRow
          key="source"
          title="stablyai/orca"
          leading={<GithubIcon size={18} />}
          accessibilityLabel={t('settings.aboutScreen.sourceCode', 'Orca source code')}
          onPress={() => openLink('https://github.com/stablyai/orca')}
        />
        <ListRow
          key="social"
          title="@orca_build"
          leading={<XIcon size={18} />}
          accessibilityLabel={t('settings.aboutScreen.socialProfile', 'Orca on X')}
          onPress={() => openLink('https://x.com/orca_build')}
        />
      </SettingsSection>

      <Text style={styles.versionText}>{versionLabel}</Text>
      {error && (
        <Text accessibilityRole="alert" style={styles.errorText}>
          {t('settings.aboutScreen.openLinkFailed', 'Could not open the link. Try again.')}
        </Text>
      )}
    </SettingsScreen>
  )
}

const styles = themedStyleSheet(() => ({
  brand: {
    alignItems: 'center',
    paddingVertical: spacing.xl
  },
  brandName: {
    fontSize: 22,
    fontWeight: '800',
    color: colors.textPrimary,
    marginTop: spacing.sm
  },
  brandSub: {
    fontSize: 13,
    color: colors.textMuted,
    marginTop: spacing.xs
  },
  versionText: {
    marginTop: spacing.lg,
    textAlign: 'center',
    fontSize: typography.metaSize,
    color: colors.textMuted
  },
  errorText: {
    marginTop: spacing.sm,
    textAlign: 'center',
    fontSize: typography.metaSize,
    color: colors.statusRed
  }
}))
