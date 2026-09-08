import { useMobileWebNativeShell } from '../../src/mobile-web/src/native-shell-channel'
import { useState } from 'react'
import { Text } from 'react-native'
import { colors, typography, spacing } from '../src/theme/mobile-theme'
import { useRouter } from 'expo-router'
import { Shield, LifeBuoy } from 'lucide-react-native'
import { MobileSettingsFrame, MobileSettingsSection } from '../src/settings/mobile-settings-menu'
import { mobileSettingsMenuItems } from '../src/settings/mobile-settings-menu-items'

export default function HostedSettingsRoute() {
  const router = useRouter()
  const [linkError, setLinkError] = useState<string | null>(null)
  const shell = useMobileWebNativeShell()
  const linksDisabled = !(shell.client?.native.supports('openExternal') ?? false)
  const openExternal = (url: string) => {
    setLinkError(null)
    void shell.client?.native
      .openExternal(url)
      .catch(() => setLinkError('Could not open the link. Try again.'))
  }
  return (
    <MobileSettingsFrame
      onBack={() => {
        if (router.canGoBack()) {
          router.back()
        } else {
          router.replace('/')
        }
      }}
    >
      <MobileSettingsSection
        items={mobileSettingsMenuItems((route) => router.push(route), {
          shell: Boolean(shell.client),
          pagePreferences: shell.client?.native.supports('pagePreferences') ?? false
        })}
      />
      <MobileSettingsSection
        spaced
        items={[
          {
            label: 'Privacy Policy',
            icon: Shield,
            external: true,
            disabled: linksDisabled,
            onPress: () => openExternal('https://www.onorca.dev/privacy')
          },
          {
            label: 'Support',
            icon: LifeBuoy,
            external: true,
            disabled: linksDisabled,
            onPress: () => openExternal('https://github.com/stablyai/orca/issues')
          }
        ]}
      />
      {linkError && (
        <Text
          accessibilityRole="alert"
          style={{
            color: colors.textSecondary,
            fontSize: typography.bodySize,
            marginTop: spacing.md
          }}
        >
          {linkError}
        </Text>
      )}
    </MobileSettingsFrame>
  )
}
