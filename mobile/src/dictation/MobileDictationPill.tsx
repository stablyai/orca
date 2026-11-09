import { useContext, useEffect } from 'react'
import { Pressable, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { CircleAlert, Laptop, Smartphone } from 'lucide-react-native'
import type { UseMobileDictationResult } from '../hooks/mobile-dictation-session-state'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import {
  MobileDictationGrapes,
  MobileDictationTimer,
  useMobileDictationElapsed
} from './MobileDictationMeter'
import {
  MobileDictationCancelButton,
  MobileDictationMicIcon,
  MobileDictationRetryButton
} from './MobileDictationLiveControls'
import {
  dictationControlsCopy,
  dictationFailureReason,
  dictationSpokenDuration
} from './mobile-dictation-controls-copy'
import { dictationAwayCopy } from './mobile-dictation-away-copy'
import { composerInputStyles } from '../components/composer-input/composer-input-styles'
import { MobileDictationStatusAnnouncement } from './MobileDictationStatusAnnouncement'
import {
  useMobileDictationHost,
  useMobileDictationHostLive,
  MobileDictationPillContext,
  type MobileDictationHostToast
} from './mobile-dictation-host-context'

const TOAST_MS = 4000
// Long enough to read the target's name and reach Open.
const TOAST_WITH_OPEN_MS = 6000

// The meter needs a live recording; finishing and failures show words instead.
function PillStatus({
  dictation,
  elapsedSeconds
}: {
  dictation: UseMobileDictationResult
  elapsedSeconds: number
}) {
  if (dictation.failure) {
    return (
      <Text style={styles.sub} numberOfLines={1}>
        {`${dictationFailureReason(dictation.failure)} · ${dictationControlsCopy.recordingKept()}`}
      </Text>
    )
  }
  if (!dictation.isRecording) {
    return (
      <Text style={styles.sub} numberOfLines={1}>
        {dictation.isStarting ? dictationAwayCopy.starting() : dictationAwayCopy.finishing()}
      </Text>
    )
  }
  return (
    <View style={styles.subRow}>
      <View style={styles.recDot} />
      <Text style={styles.sub}>{dictationAwayCopy.listening()}</Text>
      <Text style={styles.sub}>·</Text>
      <MobileDictationTimer elapsedSeconds={elapsedSeconds} />
      {dictation.engine ? (
        <>
          <Text style={styles.sub}>·</Text>
          {dictation.engine.kind === 'phone' ? (
            <Smartphone size={13} color={colors.textMuted} strokeWidth={2} />
          ) : (
            <Laptop size={14} color={colors.textMuted} strokeWidth={2} />
          )}
        </>
      ) : null}
    </View>
  )
}

// The dictation whose target is off screen: tap to go back, ✕ and Stop work from here; a failure stays until Retry or ✕.
function MobileDictationPill({
  title,
  onOpen,
  onStop
}: {
  title: string
  onOpen: () => void
  onStop: () => void
}) {
  // Subscribed only while the pill shows, so a hidden pill never re-renders on the dictation's ticks.
  const dictation = useMobileDictationHostLive(useMobileDictationHost())
  const { elapsedSeconds } = useMobileDictationElapsed(dictation.meter)
  const failed = dictation.failure !== null
  return (
    <View style={styles.pill}>
      <Pressable
        style={styles.body}
        onPress={onOpen}
        accessibilityRole="button"
        accessibilityLabel={
          failed
            ? `${dictationAwayCopy.stopped()}, ${title}`
            : dictationAwayCopy.label(title, dictationSpokenDuration(elapsedSeconds))
        }
        accessibilityHint={dictationAwayCopy.hint()}
      >
        {failed ? (
          <CircleAlert size={18} color={colors.statusRed} strokeWidth={2.2} />
        ) : (
          <MobileDictationGrapes meter={dictation.meter} dotSize={4} />
        )}
        <View style={styles.titles}>
          <Text style={styles.title} numberOfLines={1}>
            {failed ? dictationAwayCopy.stopped() : title}
          </Text>
          <PillStatus dictation={dictation} elapsedSeconds={elapsedSeconds} />
        </View>
      </Pressable>
      <MobileDictationCancelButton onCancel={() => void dictation.cancel()} discards={failed} />
      {failed ? (
        <MobileDictationRetryButton onRetry={() => void dictation.retry()} labelled />
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            dictation.isProcessing
              ? dictationControlsCopy.finishing()
              : dictationControlsCopy.stop()
          }
          aria-busy={dictation.isStarting || dictation.isProcessing}
          disabled={dictation.isProcessing}
          style={({ pressed }) => [
            composerInputStyles.controlButton,
            pressed && composerInputStyles.pressed
          ]}
          onPress={onStop}
        >
          <MobileDictationMicIcon
            active={dictation.isStarting || dictation.isRecording}
            processing={dictation.isProcessing}
            micSize={17}
            micStroke={2}
          />
        </Pressable>
      )}
    </View>
  )
}

function MobileDictationToast({
  toast,
  onDone,
  bottom
}: {
  toast: MobileDictationHostToast | null
  onDone: () => void
  bottom: number
}) {
  useEffect(() => {
    if (!toast) {
      return
    }
    const timer = setTimeout(onDone, toast.open ? TOAST_WITH_OPEN_MS : TOAST_MS)
    return () => clearTimeout(timer)
  }, [onDone, toast])
  // The host's announcer reads the message (shell or live region), so the toast itself stays quiet.
  return (
    <View style={[styles.toastRow, { bottom }]} pointerEvents="box-none">
      {toast ? (
        <View style={styles.toast}>
          <Text style={styles.toastText} numberOfLines={2}>
            {toast.message}
          </Text>
          {toast.open ? (
            <Pressable
              accessibilityRole="button"
              hitSlop={8}
              onPress={() => {
                onDone()
                toast.open?.()
              }}
            >
              <Text style={styles.toastAction}>{dictationAwayCopy.open()}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  )
}

// Floats over every screen of the host document, above the bottom inset.
export function MobileDictationPillLayer(): React.JSX.Element | null {
  useMobileColorScheme()
  useMobileTranslation()
  const insets = useSafeAreaInsets()
  const { stop } = useMobileDictationHost()
  const pill = useContext(MobileDictationPillContext)
  if (!pill) {
    return null
  }
  // Above the home indicator, or above a screen's bottom bar when it reported one.
  const pillBottom = Math.max(insets.bottom + spacing.md, pill.clearance + spacing.sm)
  return (
    <>
      {pill.away ? (
        <View style={[styles.layer, { bottom: pillBottom }]} pointerEvents="box-none">
          <MobileDictationPill title={pill.title} onOpen={pill.open} onStop={stop} />
        </View>
      ) : null}
      <MobileDictationStatusAnnouncement liveText={pill.liveText} />
      <MobileDictationToast
        toast={pill.toast}
        onDone={pill.clearToast}
        bottom={pillBottom + (pill.away ? PILL_HEIGHT + spacing.sm : 0)}
      />
    </>
  )
}

const PILL_HEIGHT = 56

const styles = themedStyleSheet(() => ({
  // Above every screen's own floating controls, below drawers and the host's pending cover (1000).
  layer: {
    position: 'absolute',
    left: spacing.lg,
    right: spacing.lg,
    zIndex: 900,
    elevation: 9
  },
  pill: {
    height: PILL_HEIGHT,
    borderRadius: radii.pill,
    backgroundColor: colors.bgRaised,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingLeft: spacing.lg,
    paddingRight: spacing.sm,
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8
  },
  body: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    alignSelf: 'stretch'
  },
  titles: {
    flex: 1,
    minWidth: 0,
    gap: 1
  },
  title: {
    color: colors.textPrimary,
    fontSize: typography.bodySize + 1,
    fontWeight: '600'
  },
  subRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5
  },
  sub: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    flexShrink: 1
  },
  recDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.statusRed
  },
  toastRow: {
    position: 'absolute',
    left: spacing.lg,
    right: spacing.lg,
    alignItems: 'center',
    zIndex: 900,
    elevation: 9
  },
  toast: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    maxWidth: 360,
    backgroundColor: colors.bgRaised,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.surface,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm
  },
  toastText: {
    flexShrink: 1,
    color: colors.textPrimary,
    fontSize: 13
  },
  toastAction: {
    color: colors.accentBlue,
    fontSize: 13,
    fontWeight: '600'
  }
}))
