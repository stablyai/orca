import { QrCode } from 'lucide-react-native'
import { Pressable, ScrollView, Text, View } from 'react-native'
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
        'home.emptyState.scanCodeDescription',
        'Tap the button above to open the scanner. Point at the QR code on your screen.'
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
  bottomInset: number
  contentMaxWidth: number
  isWideLayout: boolean
  onPairDesktop: () => void
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  // Scrolls because a phone in landscape is shorter than the hero and the steps together.
  return (
    <ScrollView
      contentContainerStyle={[
        styles.emptyContainer,
        { paddingBottom: props.bottomInset },
        props.isWideLayout && {
          maxWidth: props.contentMaxWidth,
          width: '100%',
          alignSelf: 'center'
        }
      ]}
    >
      <View style={styles.emptyHero}>
        <Text style={styles.emptyTitle}>{t('home.emptyState.title', 'Connect your desktop')}</Text>
        <Text style={styles.emptyBody}>
          {t(
            'home.emptyState.description',
            'Pair with Orca on your computer to check on your agents, jump into any terminal, and drive work from your phone.'
          )}
        </Text>
        <Pressable style={styles.primaryButton} onPress={props.onPairDesktop}>
          <QrCode size={17} color={colors.bgBase} />
          <Text style={styles.primaryButtonText}>
            {t('home.emptyState.pairDesktop', 'Pair Desktop')}
          </Text>
        </Pressable>
      </View>
      <View style={styles.stepsSection}>
        <Text style={styles.sectionHeading}>
          {t('home.emptyState.stepsHeading', 'How it works')}
        </Text>
        {onboardingSteps(t).map((step, index) => (
          <View key={step.id} style={[styles.stepRow, index > 0 && styles.stepRowBorder]}>
            <View style={styles.stepNum}>
              <Text style={styles.stepNumText}>{index + 1}</Text>
            </View>
            <View style={styles.stepText}>
              <Text style={styles.stepTitle}>{step.title}</Text>
              <Text style={styles.stepDesc}>{step.desc}</Text>
            </View>
          </View>
        ))}
      </View>
    </ScrollView>
  )
}

const styles = themedStyleSheet(() => ({
  emptyContainer: { flexGrow: 1 },
  emptyHero: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    paddingBottom: 40
  },
  emptyTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: colors.textPrimary,
    textAlign: 'center',
    marginBottom: 10
  },
  emptyBody: {
    fontSize: 15,
    color: colors.textSecondary,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 32
  },
  primaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: colors.textPrimary,
    paddingHorizontal: 28,
    paddingVertical: 14,
    borderRadius: radii.card
  },
  primaryButtonText: { color: colors.bgBase, fontSize: 15, fontWeight: '700' },
  stepsSection: { paddingHorizontal: spacing.xl },
  sectionHeading: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.xs
  },
  stepRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 14,
    paddingVertical: spacing.lg
  },
  stepRowBorder: { borderTopWidth: 1, borderTopColor: colors.borderSubtle },
  stepNum: {
    width: 28,
    height: 28,
    borderRadius: 8,
    backgroundColor: colors.bgPanel,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1
  },
  stepNumText: { fontSize: 12, fontWeight: '700', color: colors.textSecondary },
  stepText: { flex: 1 },
  stepTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.textPrimary,
    marginBottom: 3
  },
  stepDesc: { fontSize: 12, color: colors.textMuted, lineHeight: 17 }
}))
