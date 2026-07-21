import { Pressable, StyleSheet, ActivityIndicator } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Mic, Volume2 } from 'lucide-react-native'
import { colors, spacing } from '../theme/mobile-theme'
import { FAB_SIZE } from './NewWorkspaceFab'

// Hold-to-talk mic on the HOST panel — the "ask about the fleet" surface, used
// before you pick an individual workspace. Distinct from the per-session
// composer dictation, which types INTO one agent; this asks Herm a broad
// question and gets a spoken answer back.
//
// Bottom-right by operator direction: it's the natural thumb rest, and hold-to-
// talk wants the corner you can press without looking. "+" moved to bottom-left
// so a mis-grab creates nothing.

export type HostVoicePhase = 'idle' | 'recording' | 'thinking' | 'speaking'

type HostVoiceFabProps = {
  phase: HostVoicePhase
  disabled?: boolean
  onPressIn: () => void
  onPressOut: () => void
}

export function HostVoiceFab({
  phase,
  disabled,
  onPressIn,
  onPressOut
}: HostVoiceFabProps): React.JSX.Element {
  const insets = useSafeAreaInsets()
  const busy = phase === 'thinking'
  // Why: the recording fill is saturated red — the dark bgBase icon used on the
  // near-white idle surface would lose contrast against it.
  const iconColor = phase === 'recording' ? colors.onAccent : colors.bgBase
  return (
    <Pressable
      style={({ pressed }) => [
        styles.fab,
        { bottom: spacing.xl + insets.bottom },
        phase === 'recording' && styles.fabRecording,
        (pressed || phase === 'speaking') && styles.fabActive,
        disabled && styles.fabDisabled
      ]}
      // Why: press-IN starts the mic and press-OUT stops it — walkie-talkie,
      // not a toggle. A toggle strands the mic open when the phone pockets.
      onPressIn={onPressIn}
      onPressOut={onPressOut}
      disabled={disabled || busy}
      accessibilityRole="button"
      accessibilityLabel="Hold to ask Herm about this host"
      accessibilityState={{ busy, disabled: disabled || busy }}
      hitSlop={8}
    >
      {busy ? (
        <ActivityIndicator size="small" color={colors.bgBase} />
      ) : phase === 'speaking' ? (
        <Volume2 size={22} color={iconColor} strokeWidth={2.5} />
      ) : (
        <Mic size={22} color={iconColor} strokeWidth={2.5} />
      )}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  fab: {
    position: 'absolute',
    right: spacing.lg,
    width: FAB_SIZE,
    height: FAB_SIZE,
    borderRadius: FAB_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceBright,
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4
  },
  // Recording is the one state worth a color: the mic is open and the operator
  // must be able to tell at a glance (STYLEGUIDE: color is for state).
  fabRecording: {
    backgroundColor: colors.statusRed
  },
  fabActive: {
    backgroundColor: colors.textPrimary
  },
  fabDisabled: {
    opacity: 0.5
  }
})
