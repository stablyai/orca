import { useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { Globe } from 'lucide-react-native'
import Svg, { Path } from 'react-native-svg'
import { OrcaLogo } from '../components/OrcaLogo'
import { colors, spacing, textStyles } from '../theme/mobile-theme'
import { LIST_LEADING_INSET } from '../components/ui/ListGroup'
import { ListRow } from '../components/ui/ListRow'
import { Banner } from '../components/ui/Banner'
import {
  ExternalLinkAccessory,
  SettingsFooter,
  SettingsRowIcon,
  SettingsScreen,
  SettingsSection
} from './settings-screen-frame'

// lucide-react-native ships no brand marks, so GitHub and X stay hand-drawn.

function GithubIcon({ size = 18, color = colors.textSecondary }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill={color}>
      <Path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
    </Svg>
  )
}

function XIcon({ size = 16, color = colors.textSecondary }) {
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
  const [error, setError] = useState<string | null>(null)
  const openLink = (url: string) => {
    setError(null)
    void openExternal(url).catch(() => setError('Could not open the link. Try again.'))
  }
  const links = [
    {
      title: 'Website',
      value: 'onorca.dev',
      label: 'Orca website',
      icon: <SettingsRowIcon icon={Globe} />,
      url: 'https://onOrca.dev'
    },
    {
      title: 'Source code',
      value: 'stablyai/orca',
      label: 'Orca source code',
      icon: <GithubIcon />,
      url: 'https://github.com/stablyai/orca'
    },
    {
      title: 'X',
      value: '@orca_build',
      label: 'Orca on X',
      icon: <XIcon />,
      url: 'https://x.com/orca_build'
    }
  ]

  return (
    <SettingsScreen title="About" onBack={onBack}>
      <View style={styles.brand}>
        <OrcaLogo size={48} />
        <Text style={styles.brandName}>Orca</Text>
        <Text style={styles.brandSub}>Open-source agent IDE for 100x builders</Text>
      </View>

      {error ? (
        <View style={styles.banner}>
          <Banner tone="error" message={error} onDismiss={() => setError(null)} />
        </View>
      ) : null}

      <SettingsSection separatorInset={LIST_LEADING_INSET}>
        {links.map((link) => (
          <ListRow
            key={link.title}
            title={link.title}
            value={link.value}
            leading={link.icon}
            accessory={<ExternalLinkAccessory />}
            accessibilityRole="link"
            accessibilityLabel={link.label}
            onPress={() => openLink(link.url)}
          />
        ))}
      </SettingsSection>
      <SettingsFooter>{versionLabel}</SettingsFooter>
    </SettingsScreen>
  )
}

const styles = StyleSheet.create({
  brand: {
    alignItems: 'center',
    gap: spacing.xs,
    paddingTop: spacing.xl,
    paddingBottom: spacing.sm
  },
  brandName: { ...textStyles.title, color: colors.textPrimary, marginTop: spacing.sm },
  brandSub: { ...textStyles.subhead, color: colors.textSecondary, textAlign: 'center' },
  banner: { marginTop: spacing.md }
})
