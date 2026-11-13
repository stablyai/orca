import { useEffect, useMemo, useState, type Ref } from 'react'
import { ActivityIndicator, Pressable, Text, View, type HostInstance } from 'react-native'
import {
  ArrowUp,
  CircleAlert,
  Laptop,
  Mic,
  RotateCcw,
  Smartphone,
  Square,
  X
} from 'lucide-react-native'
import type { MobileDictationMeter } from '../hooks/mobile-dictation-meter'
import type { MobileDictationEngineShown } from '../hooks/mobile-dictation-session-state'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import {
  COMPOSER_CONTROL_HIT_SLOP,
  COMPOSER_CONTROL_SIZE,
  composerInputStyles
} from '../components/composer-input/composer-input-styles'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import {
  MobileDictationGrapes,
  MobileDictationTimer,
  useMobileDictationElapsed
} from './MobileDictationMeter'
import { dictationControlsCopy, dictationMeterLabel } from './mobile-dictation-controls-copy'

// Automatic's move from the phone to the computer is named in words this long, then the icon returns.
const MOVED_NOTE_MS = 3000
// A computer finish that lands within this shows no note, so a fast finish never flashes one.
const FINISHING_NOTE_DELAY_MS = 300

// Cancel sits where attach was, far from Stop; a hold released over it cancels too.
export function MobileDictationCancelButton({
  onCancel,
  targetRef,
  compact = false,
  discards = false,
  label
}: {
  onCancel: () => void
  targetRef?: Ref<HostInstance>
  compact?: boolean
  // After a failure, ✕ throws the kept recording away.
  discards?: boolean
  label?: string
}): React.JSX.Element {
  useMobileColorScheme()
  useMobileTranslation()
  return (
    <Pressable
      ref={targetRef}
      accessibilityRole="button"
      accessibilityLabel={
        label ?? (discards ? dictationControlsCopy.discard() : dictationControlsCopy.cancel())
      }
      style={({ pressed }) => [
        composerInputStyles.controlButton,
        compact && styles.compactCancel,
        pressed && composerInputStyles.pressed
      ]}
      hitSlop={COMPOSER_CONTROL_HIT_SLOP}
      onPress={onCancel}
    >
      <X
        pointerEvents="none"
        size={compact ? 16 : 18}
        color={colors.textPrimary}
        strokeWidth={2.4}
      />
    </Pressable>
  )
}

// The mic's face: a spinner while finishing, a red Stop while live, else the mic. Icons ignore touches, so a swap mid-hold keeps the press.
export function MobileDictationMicIcon({
  active,
  processing,
  micSize,
  micStroke
}: {
  active: boolean
  processing: boolean
  micSize: number
  micStroke: number
}): React.JSX.Element {
  useMobileColorScheme()
  return processing ? (
    <ActivityIndicator pointerEvents="none" size="small" color={colors.textSecondary} />
  ) : active ? (
    <Square
      pointerEvents="none"
      size={16}
      color={colors.statusRed}
      strokeWidth={2.4}
      fill={colors.statusRed}
    />
  ) : (
    <Mic pointerEvents="none" size={micSize} color={colors.textSecondary} strokeWidth={micStroke} />
  )
}

// The failure that kept its recording: a reason and "Recording kept", on two lines in chat and one in the terminal.
export function MobileDictationFailureNote({
  reason,
  compact = false
}: {
  reason: string
  compact?: boolean
}): React.JSX.Element {
  useMobileColorScheme()
  useMobileTranslation()
  const kept = dictationControlsCopy.recordingKept()
  return (
    <View style={styles.row} accessible accessibilityLabel={`${reason}. ${kept}.`}>
      <CircleAlert
        pointerEvents="none"
        size={compact ? 15 : 17}
        color={colors.statusRed}
        strokeWidth={2.2}
      />
      {compact ? (
        <Text style={styles.failureCompact} numberOfLines={1}>
          {`${reason} · ${kept}`}
        </Text>
      ) : (
        <View style={styles.failureLines}>
          <Text style={styles.failureReason} numberOfLines={1}>
            {reason}
          </Text>
          <Text style={styles.failureKept} numberOfLines={1}>
            {kept}
          </Text>
        </View>
      )}
    </View>
  )
}

// Retry sits where Stop was: a labelled pill in chat, the round control in the terminal.
export function MobileDictationRetryButton({
  onRetry,
  labelled
}: {
  onRetry: () => void
  labelled: boolean
}): React.JSX.Element {
  useMobileColorScheme()
  useMobileTranslation()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={dictationControlsCopy.retry()}
      style={({ pressed }) => [
        labelled ? styles.retryPill : composerInputStyles.controlButton,
        pressed && composerInputStyles.pressed
      ]}
      hitSlop={COMPOSER_CONTROL_HIT_SLOP}
      onPress={onRetry}
    >
      <RotateCcw
        pointerEvents="none"
        size={15}
        color={labelled ? colors.bgBase : colors.textPrimary}
        strokeWidth={2.4}
      />
      {labelled ? (
        <Text style={styles.retryLabel}>{dictationControlsCopy.retryShort()}</Text>
      ) : null}
    </Pressable>
  )
}

function EngineIcon({ kind, color }: { kind: MobileDictationEngineShown['kind']; color: string }) {
  return kind === 'phone' ? (
    <Smartphone pointerEvents="none" size={15} color={color} strokeWidth={2} />
  ) : (
    <Laptop pointerEvents="none" size={16} color={color} strokeWidth={2} />
  )
}

// Dots, timer and the engine's icon; words only for the few seconds after Automatic moves to the computer.
export function MobileDictationRecordingMeter({
  meter,
  engine,
  computerName,
  dotSize
}: {
  meter: MobileDictationMeter
  engine: MobileDictationEngineShown | null
  computerName: string | null
  dotSize: number
}): React.JSX.Element {
  useMobileColorScheme()
  useMobileTranslation()
  const { now, elapsedSeconds } = useMobileDictationElapsed(meter)
  const kind = engine?.kind ?? null
  // The clock ticks four times a second; the spoken label changes once.
  const label = useMemo(
    () => dictationMeterLabel(elapsedSeconds, kind, computerName),
    [elapsedSeconds, kind, computerName]
  )
  if (engine?.movedAt != null && now - engine.movedAt < MOVED_NOTE_MS) {
    return (
      <View style={styles.row}>
        <EngineIcon kind="computer" color={colors.textPrimary} />
        <Text style={styles.moved} numberOfLines={1}>
          {dictationControlsCopy.movedTo(computerName)}
        </Text>
      </View>
    )
  }
  return (
    <View style={styles.row} role="timer" aria-label={label}>
      <View style={styles.row} importantForAccessibility="no-hide-descendants" aria-hidden>
        <MobileDictationGrapes meter={meter} dotSize={dotSize} />
        <MobileDictationTimer elapsedSeconds={elapsedSeconds} />
        {engine ? <EngineIcon kind={engine.kind} color={colors.textMuted} /> : null}
      </View>
    </View>
  )
}

// Says where a slow finish is happening; the phone finishes at once, so it never needs this. Mounted only while finishing.
export function MobileDictationFinishingNote({
  engine,
  computerName
}: {
  engine: MobileDictationEngineShown | null
  computerName: string | null
}): React.JSX.Element | null {
  useMobileColorScheme()
  useMobileTranslation()
  const onComputer = engine?.kind === 'computer'
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    if (!onComputer) {
      return
    }
    const timer = setTimeout(() => setSlow(true), FINISHING_NOTE_DELAY_MS)
    return () => clearTimeout(timer)
  }, [onComputer])
  if (!onComputer || !slow) {
    return null
  }
  return (
    <View style={styles.row}>
      <EngineIcon kind="computer" color={colors.textSecondary} />
      <Text style={styles.finishing} numberOfLines={1}>
        {dictationControlsCopy.finishingOn(computerName)}
      </Text>
    </View>
  )
}

function secondsUntil(deadline: number): number {
  return Math.max(0, Math.ceil((deadline - Date.now()) / 1000))
}

// The dictated message's send countdown; the screen reader heard it once when it began, so the ticking stays silent.
export function MobileDictationAutoSendNote({ deadline }: { deadline: number }): React.JSX.Element {
  useMobileColorScheme()
  useMobileTranslation()
  const [seconds, setSeconds] = useState(() => secondsUntil(deadline))
  useEffect(() => {
    const interval = setInterval(() => setSeconds(secondsUntil(deadline)), 250)
    return () => clearInterval(interval)
  }, [deadline])
  return (
    <View style={styles.row} importantForAccessibility="no-hide-descendants" aria-hidden>
      <ArrowUp pointerEvents="none" size={16} color={colors.textSecondary} strokeWidth={2.2} />
      <Text style={styles.finishing} numberOfLines={1}>
        {dictationControlsCopy.sendingIn(seconds)}
      </Text>
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minWidth: 0,
    flexShrink: 1
  },
  compactCancel: {
    width: 36,
    height: 36
  },
  moved: {
    flexShrink: 1,
    color: colors.textPrimary,
    fontSize: typography.metaSize + 1,
    fontWeight: '500'
  },
  finishing: {
    flexShrink: 1,
    color: colors.textSecondary,
    fontSize: typography.metaSize + 1
  },
  failureLines: {
    flexShrink: 1,
    minWidth: 0
  },
  failureReason: {
    color: colors.textPrimary,
    fontSize: typography.metaSize + 1,
    fontWeight: '500'
  },
  failureKept: {
    color: colors.textSecondary,
    fontSize: typography.metaSize
  },
  failureCompact: {
    flexShrink: 1,
    color: colors.textPrimary,
    fontSize: typography.metaSize
  },
  retryPill: {
    height: COMPOSER_CONTROL_SIZE,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.surfaceBright
  },
  retryLabel: {
    color: colors.bgBase,
    fontSize: typography.bodySize,
    fontWeight: '600'
  }
}))
