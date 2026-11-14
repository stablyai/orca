import { QrCode } from 'lucide-react-native'
import { useState } from 'react'
import { Pressable, ScrollView, Text, View } from 'react-native'
import Animated from 'react-native-reanimated'
import { NumberedStepsPanel } from '../components/NumberedStepsPanel'
import { OrcaLogo } from '../components/OrcaLogo'
import type { Translate } from '../i18n/mobile-i18n'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors, radii, spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { MobileHomeAppMoveBanner } from './MobileHomeAppMoveBanner'

function onboardingSteps(t: Translate) {
  return [
    {
      id: 'open-desktop',
      title: t('home.emptyState.openDesktopTitle', 'Open Orca desktop'),
      desc: t(
        'home.emptyState.openDesktopDescription',
        'Go to Settings → Mobile and generate a pairing QR code.'
      )
    },
    {
      id: 'scan-code',
      title: t('home.emptyState.scanCodeTitle', 'Scan the code'),
      desc: t(
        'home.emptyState.scanCodeBelowDescription',
        'Tap Pair desktop below, then point your camera at the QR code on your screen.'
      )
    },
    {
      id: 'connected',
      title: t('home.emptyState.connectedTitle', "You're connected"),
      desc: t(
        'home.emptyState.connectedDescription',
        'Your desktop will appear here. Everything is encrypted end-to-end.'
      )
    }
  ]
}

export function MobileHomeEmptyState(props: {
  contentMaxWidth: number
  isWideLayout: boolean
  bottomInset: number
  onPairDesktop: () => void
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  // Scrolls because a phone in landscape is shorter than the hero and the steps together.
  return (
    <ScrollView
      contentContainerStyle={[
        styles.container,
        { paddingBottom: props.bottomInset },
        props.isWideLayout && {
          maxWidth: props.contentMaxWidth,
          width: '100%',
          alignSelf: 'center'
        }
      ]}
    >
      <MobileHomeAppMoveBanner />
      <View style={styles.guide}>
        <View style={styles.hero}>
          <OrcaLogo size={44} />
          <Text style={styles.title} accessibilityRole="header">
            {t('home.emptyState.title', 'Connect your desktop')}
          </Text>
          <Text style={styles.body}>
            {t(
              'home.emptyState.description',
              'Pair with Orca on your computer to check on your agents, jump into any terminal, and drive work from your phone.'
            )}
          </Text>
        </View>
        <NumberedStepsPanel steps={onboardingSteps(t)} />
        <PairDesktopButton onPress={props.onPairDesktop} />
      </View>
    </ScrollView>
  )
}

function PairDesktopButton(props: { onPress: () => void }) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const [pressed, setPressed] = useState(false)
  return (
    <Pressable
      accessibilityRole="button"
      style={styles.ctaHit}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      onPress={props.onPress}
    >
      <Animated.View
        style={[
          styles.cta,
          {
            opacity: pressed ? 0.85 : 1,
            transform: [{ scale: pressed ? 0.97 : 1 }],
            transitionProperty: ['transform', 'opacity'],
            transitionDuration: pressed ? 90 : 160
          }
        ]}
      >
        <QrCode size={18} color={colors.onAccent} strokeWidth={2.2} />
        <Text style={styles.ctaLabel}>
          {t('home.emptyState.pairDesktopButton', 'Pair desktop')}
        </Text>
      </Animated.View>
    </Pressable>
  )
}

const styles = themedStyleSheet(() => ({
  container: { flexGrow: 1, padding: spacing.lg },
  // The move banner stays at the top while the pairing guide centres in the space below it.
  guide: { flexGrow: 1, justifyContent: 'center' },
  hero: { alignItems: 'center', paddingHorizontal: spacing.sm, marginBottom: 34 },
  title: {
    fontSize: 28,
    fontWeight: '700',
    letterSpacing: -0.4,
    color: colors.textPrimary,
    textAlign: 'center',
    marginTop: 26,
    marginBottom: 10
  },
  body: { fontSize: 17, lineHeight: 24, color: colors.textSecondary, textAlign: 'center' },
  ctaHit: { alignSelf: 'center', marginTop: 22 },
  cta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 48,
    paddingHorizontal: 22,
    borderRadius: radii.control,
    backgroundColor: colors.accentBlue
  },
  ctaLabel: { fontSize: 16, fontWeight: '600', color: colors.onAccent }
}))
