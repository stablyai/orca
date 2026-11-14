import * as Notifications from 'expo-notifications'
import { ArrowLeft, CircleCheck, Download, ExternalLink } from 'lucide-react-native'
import { useEffect, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { NumberedStepsPanel, type NumberedStep } from '../components/NumberedStepsPanel'
import { OrcaLogo } from '../components/OrcaLogo'
import type { Translate } from '../i18n/mobile-i18n'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useResponsiveLayout } from '../layout/responsive-layout'
import { useBackClaim } from '../navigation/use-back-claim'
import { openExternalLink } from '../platform/external-links/external-link'
import { colors, feedback, radii, spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import {
  keepRetiredApp,
  openDownloadFromPlayScreen,
  returnToPlayScreen,
  skipAppMoveForNotification,
  startAppMoveGate,
  useAppMoveState,
  type AppMoveScreen as Screen
} from './app-move-gate'
import { NEW_APP_PLAY_URL, openNewAppDownload } from './new-app-download'

function moveSteps(t: Translate, screen: Screen): NumberedStep[] {
  const first =
    screen === 'play'
      ? {
          id: 'install',
          title: t('appMove.play.installTitle', 'Install Orca from Google Play'),
          desc: t('appMove.play.installDescription', 'You can do this now, wherever you are.')
        }
      : {
          id: 'install',
          title: t('appMove.download.installTitle', 'Download the new app'),
          desc: t(
            'appMove.download.installDescription',
            'If your phone asks, allow your browser to install apps.'
          )
        }
  return [
    first,
    {
      id: 'pair',
      title: t('appMove.pairTitle', 'Pair it with your computer'),
      desc: t(
        'appMove.pairDescription',
        'In Orca on your computer, go to Settings → Mobile and scan the code.'
      )
    },
    {
      id: 'delete',
      title: t('appMove.deleteTitle', 'Delete this app'),
      desc: t(
        'appMove.deleteDescription',
        'Once the new app shows your agents. Until then, keep using this one.'
      )
    }
  ]
}

function readLaunchedFromNotification(): boolean {
  try {
    return Boolean(Notifications.getLastNotificationResponse())
  } catch {
    return false
  }
}

/** Full-screen, blocking move guide for the retired GitHub Android app; Back never dismisses it. */
export function AppMoveScreen() {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const insets = useSafeAreaInsets()
  const { isWideLayout, contentMaxWidth } = useResponsiveLayout()
  const { screen, cameFromPlay } = useAppMoveState()
  const [downloading, setDownloading] = useState(false)
  const [viewportHeight, setViewportHeight] = useState(0)
  const [contentHeight, setContentHeight] = useState(0)
  useEffect(() => {
    // Runs before the root layout's tap handler clears the launch response.
    startAppMoveGate(readLaunchedFromNotification())
    const subscription = Notifications.addNotificationResponseReceivedListener(
      skipAppMoveForNotification
    )
    return () => subscription.remove()
  }, [])
  useBackClaim(
    screen === null
      ? null
      : () => {
          if (cameFromPlay) {
            returnToPlayScreen()
          }
          return true
        }
  )
  if (screen === null) {
    return null
  }

  const download = () => {
    setDownloading(true)
    void openNewAppDownload().finally(() => setDownloading(false))
  }
  const play = screen === 'play'
  const column = isWideLayout && {
    maxWidth: contentMaxWidth,
    width: '100%' as const,
    alignSelf: 'center' as const
  }
  return (
    <View
      style={[
        styles.root,
        {
          paddingTop: insets.top,
          paddingBottom: insets.bottom,
          paddingLeft: insets.left,
          paddingRight: insets.right
        }
      ]}
      accessibilityViewIsModal
    >
      {cameFromPlay ? (
        <View style={styles.top}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('common.back', 'Back')}
            style={({ pressed }) => [styles.back, pressed && styles.pressed]}
            onPress={returnToPlayScreen}
          >
            <ArrowLeft size={24} color={colors.textPrimary} strokeWidth={2} />
          </Pressable>
        </View>
      ) : null}
      <ScrollView
        contentContainerStyle={[styles.scroll, !cameFromPlay && styles.scrollNoTopBar, column]}
        onLayout={(event) => setViewportHeight(event.nativeEvent.layout.height)}
        onContentSizeChange={(_, height) => setContentHeight(height)}
      >
        <View style={styles.hero}>
          <OrcaLogo size={44} />
          <Text style={styles.title} accessibilityRole="header">
            {play
              ? t('appMove.play.title', 'Orca is now on Google Play')
              : t('appMove.download.title', 'Get the new Orca app')}
          </Text>
          <Text style={styles.body}>
            {play
              ? t(
                  'appMove.play.description',
                  'This app still works, but updates now come from Google Play. Switching takes a few minutes.'
                )
              : t(
                  'appMove.download.description',
                  'This app still works, but updates and security fixes now come through the new app. Switching takes a few minutes.'
                )}
          </Text>
        </View>
        <NumberedStepsPanel steps={moveSteps(t, screen)} />
        <View style={styles.reassurance}>
          <CircleCheck size={20} color={colors.statusGreen} strokeWidth={2} />
          <Text style={styles.reassuranceText}>
            {t(
              'appMove.dataKept',
              "Your agents, chats and workspaces are saved on your computer, so you'll see them all in the new app."
            )}
          </Text>
        </View>
      </ScrollView>
      <View
        style={[styles.actions, contentHeight > viewportHeight && styles.actionsOverScroll, column]}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: downloading }}
          disabled={downloading}
          style={({ pressed }) => [
            styles.cta,
            pressed && styles.pressed,
            downloading && styles.disabled
          ]}
          onPress={play ? () => openExternalLink(NEW_APP_PLAY_URL) : download}
        >
          {play ? (
            <ExternalLink size={18} color={colors.onAccent} strokeWidth={2.2} />
          ) : (
            <Download size={18} color={colors.onAccent} strokeWidth={2.2} />
          )}
          <Text style={styles.ctaLabel}>
            {play
              ? t('appMove.play.openGooglePlay', 'Open Google Play')
              : t('appMove.download.download', 'Download')}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}
          onPress={play ? openDownloadFromPlayScreen : keepRetiredApp}
        >
          <Text style={styles.secondaryLabel}>
            {play
              ? t('appMove.play.cantUseGooglePlay', "I can't use Google Play")
              : t('appMove.download.keepThisVersion', 'Keep using this version')}
          </Text>
        </Pressable>
        {play ? null : (
          <Text style={styles.finePrint}>
            {t(
              'appMove.download.keepThisVersionNote',
              "You'll miss security fixes. We'll remind you in a week."
            )}
          </Text>
        )}
      </View>
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  root: { ...StyleSheet.absoluteFill, backgroundColor: colors.bgBase },
  top: { height: 52, flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.sm },
  back: {
    width: 44,
    height: 44,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center'
  },
  scroll: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: spacing.lg },
  scrollNoTopBar: { paddingTop: spacing.xl },
  hero: { alignItems: 'center', paddingHorizontal: spacing.sm, marginBottom: spacing.xl },
  title: {
    fontSize: 28,
    lineHeight: 34,
    fontWeight: '700',
    letterSpacing: -0.4,
    color: colors.textPrimary,
    textAlign: 'center',
    marginTop: 20,
    marginBottom: 10
  },
  body: { fontSize: 17, lineHeight: 24, color: colors.textSecondary, textAlign: 'center' },
  reassurance: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    paddingTop: 14,
    paddingLeft: 6,
    paddingRight: spacing.xs
  },
  reassuranceText: {
    flex: 1,
    minWidth: 0,
    fontSize: 15,
    lineHeight: 20,
    color: colors.textSecondary
  },
  actions: {
    gap: spacing.xs,
    paddingTop: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingBottom: 18
  },
  // A hairline marks that the guide scrolls on under the pinned buttons (long languages, small phones).
  actionsOverScroll: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle
  },
  cta: {
    height: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    borderRadius: radii.control,
    backgroundColor: colors.accentBlue
  },
  ctaLabel: { fontSize: 16, fontWeight: '600', color: colors.onAccent },
  secondary: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  secondaryLabel: { fontSize: 16, fontWeight: '500', color: colors.textSecondary },
  finePrint: {
    marginTop: -6,
    fontSize: 13,
    lineHeight: 18,
    color: colors.textMuted,
    textAlign: 'center'
  },
  pressed: { opacity: feedback.pressedOpacity },
  disabled: { opacity: feedback.disabledOpacity }
}))
