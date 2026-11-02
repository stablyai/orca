import { Fragment } from 'react'
import { ScrollView, StyleSheet, Text, View } from 'react-native'
import { OrcaLogo } from '../components/OrcaLogo'
import type { Translate } from '../i18n/mobile-i18n'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors, radii, spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'

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

export function MobileHomeEmptyState(props: { contentMaxWidth: number; isWideLayout: boolean }) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  // Scrolls because a phone in landscape is shorter than the hero and the steps together.
  return (
    <ScrollView
      contentContainerStyle={[
        styles.container,
        props.isWideLayout && {
          maxWidth: props.contentMaxWidth,
          width: '100%',
          alignSelf: 'center'
        }
      ]}
    >
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
      <View style={styles.steps}>
        {onboardingSteps(t).map((step, index) => (
          <Fragment key={step.id}>
            {index > 0 ? <View style={styles.separator} /> : null}
            <View style={styles.step}>
              <View style={styles.stepNumber}>
                <Text style={styles.stepNumberText}>{index + 1}</Text>
              </View>
              <View style={styles.stepText}>
                <Text style={styles.stepTitle}>{step.title}</Text>
                <Text style={styles.stepDescription}>{step.desc}</Text>
              </View>
            </View>
          </Fragment>
        ))}
      </View>
    </ScrollView>
  )
}

const STEP_NUMBER_SIZE = 26

const styles = themedStyleSheet(() => ({
  container: { flexGrow: 1, justifyContent: 'center', padding: spacing.lg },
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
  steps: { backgroundColor: colors.bgPanel, borderRadius: radii.surface, overflow: 'hidden' },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle,
    marginLeft: spacing.lg + STEP_NUMBER_SIZE + 14
  },
  step: { flexDirection: 'row', alignItems: 'flex-start', gap: 14, padding: spacing.lg },
  stepNumber: {
    width: STEP_NUMBER_SIZE,
    height: STEP_NUMBER_SIZE,
    borderRadius: radii.pill,
    backgroundColor: colors.bgRaised,
    alignItems: 'center',
    justifyContent: 'center'
  },
  stepNumberText: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.textPrimary,
    fontVariant: ['tabular-nums']
  },
  stepText: { flex: 1, minWidth: 0 },
  stepTitle: { fontSize: 17, lineHeight: 22, color: colors.textPrimary },
  stepDescription: { fontSize: 15, lineHeight: 20, color: colors.textSecondary, marginTop: 2 }
}))
