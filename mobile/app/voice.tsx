import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { View, Text, StyleSheet, Pressable, ScrollView } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { ChevronLeft, Mic, Square } from 'lucide-react-native'
import {
  initialize,
  tearDown,
  toggleRecording,
  useMicrophonePermissions,
  useExpoTwoWayAudioEventListener
} from '@orca/expo-two-way-audio'
import { colors, radii, spacing, typography } from '../src/theme/mobile-theme'

// A1 shell: dedicated Voice page. Talk control + live input waveform driven by
// @orca/expo-two-way-audio volume events, plus the turn state machine. The
// STT -> agent-PTY inject -> TTS return path is wired in A2 (see
// plans/active/2026-07-20-orca-mobile-voice-pet-canvas.md); until then the
// talk control records locally so the waveform + permission flow are
// dogfoolable end to end on the Nord.

type VoiceState = 'idle' | 'listening' | 'processing' | 'speaking' | 'error'
type TalkMode = 'hold' | 'toggle'

const WAVE_BARS = 32

const STATE_LABEL: Record<VoiceState, string> = {
  idle: 'Tap to talk',
  listening: 'Listening…',
  processing: 'Thinking…',
  speaking: 'Speaking…',
  error: 'Something went wrong'
}

export default function VoiceScreen(): React.JSX.Element {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const [permission, requestPermission] = useMicrophonePermissions()
  const [state, setState] = useState<VoiceState>('idle')
  const [mode, setMode] = useState<TalkMode>('hold')
  const [levels, setLevels] = useState<number[]>(() => Array.from({ length: WAVE_BARS }, () => 0))
  const [transcript, setTranscript] = useState<string>('')
  const audioReady = useRef(false)
  const processingTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let cancelled = false
    initialize()
      .then(() => {
        if (!cancelled) {
          audioReady.current = true
        }
      })
      .catch(() => {
        if (!cancelled) {
          setState('error')
        }
      })
    return () => {
      cancelled = true
      if (processingTimer.current) {
        clearTimeout(processingTimer.current)
      }
      try {
        toggleRecording(false)
      } catch {
        // best effort on unmount
      }
      tearDown()
    }
  }, [])

  // Push each input-volume sample into a fixed-width ring for the waveform.
  useExpoTwoWayAudioEventListener('onInputVolumeLevelData', (event) => {
    const v = Math.max(0, Math.min(1, event.data))
    setLevels((prev) => {
      const next = prev.slice(1)
      next.push(v)
      return next
    })
  })

  const stopListening = useCallback(() => {
    try {
      toggleRecording(false)
    } catch {
      // ignore
    }
    setLevels(Array.from({ length: WAVE_BARS }, () => 0))
    // A2: hand the captured audio to mesh-stt-parakeet via the paired desktop,
    // inject the transcript into the active agent PTY, then play the TTS reply.
    setState('processing')
    setTranscript('(transcription + agent reply wired in A2)')
    processingTimer.current = setTimeout(() => setState('idle'), 900)
  }, [])

  const startListening = useCallback(async () => {
    if (processingTimer.current) {
      clearTimeout(processingTimer.current)
      processingTimer.current = null
    }
    if (!permission?.granted) {
      const res = await requestPermission()
      if (!res.granted) {
        setState('error')
        return
      }
    }
    setTranscript('')
    setState('listening')
    try {
      toggleRecording(true)
    } catch {
      setState('error')
    }
  }, [permission, requestPermission])

  const onTalkPress = useCallback(() => {
    if (mode === 'toggle') {
      if (state === 'listening') {
        stopListening()
      } else {
        void startListening()
      }
    }
  }, [mode, state, startListening, stopListening])

  const isListening = state === 'listening'
  const talkHint = useMemo(
    () => (mode === 'hold' ? 'Hold to talk' : 'Tap to start / stop'),
    [mode]
  )

  return (
    <View style={[styles.container, { paddingTop: insets.top + spacing.sm }]}>
      <View style={styles.topRow}>
        <Pressable style={styles.backButton} onPress={() => router.back()}>
          <ChevronLeft size={22} color={colors.textSecondary} />
        </Pressable>
        <Text style={styles.heading}>Voice</Text>
      </View>

      <View style={styles.targetRow}>
        <Text style={styles.targetLabel}>Target</Text>
        <View style={styles.targetChip}>
          <Text style={styles.targetChipText}>Active terminal</Text>
        </View>
      </View>

      <View style={styles.stage}>
        <View style={styles.waveform}>
          {levels.map((lvl, i) => (
            <View
              key={i}
              style={[
                styles.waveBar,
                {
                  height: 4 + lvl * 96,
                  backgroundColor: isListening ? colors.accentBlue : colors.borderSubtle
                }
              ]}
            />
          ))}
        </View>
        <Text style={styles.stateLabel}>{STATE_LABEL[state]}</Text>
        <ScrollView style={styles.transcript} contentContainerStyle={styles.transcriptContent}>
          <Text style={styles.transcriptText}>{transcript || talkHint}</Text>
        </ScrollView>
      </View>

      <View style={styles.controls}>
        <View style={styles.modeToggle}>
          {(['hold', 'toggle'] as TalkMode[]).map((m) => (
            <Pressable
              key={m}
              style={[styles.modeOption, mode === m && styles.modeOptionActive]}
              onPress={() => setMode(m)}
            >
              <Text style={[styles.modeText, mode === m && styles.modeTextActive]}>
                {m === 'hold' ? 'Hold' : 'Toggle'}
              </Text>
            </Pressable>
          ))}
        </View>

        <Pressable
          style={[styles.talkButton, isListening && styles.talkButtonActive]}
          onPress={onTalkPress}
          onPressIn={mode === 'hold' ? () => void startListening() : undefined}
          onPressOut={mode === 'hold' ? stopListening : undefined}
          accessibilityLabel={isListening ? 'Stop talking' : 'Talk'}
        >
          {isListening ? (
            <Square size={30} color={colors.onAccent} fill={colors.onAccent} />
          ) : (
            <Mic size={34} color={colors.textPrimary} />
          )}
        </Pressable>
        <Text style={styles.talkHint}>{talkHint}</Text>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgBase,
    paddingHorizontal: spacing.lg
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.lg
  },
  backButton: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: -spacing.sm
  },
  heading: {
    color: colors.textPrimary,
    fontSize: typography.titleSize,
    fontWeight: '700'
  },
  targetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  targetLabel: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    textTransform: 'uppercase',
    letterSpacing: 0.5
  },
  targetChip: {
    backgroundColor: colors.bgPanel,
    borderRadius: radii.button,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs
  },
  targetChipText: {
    color: colors.textPrimary,
    fontSize: typography.bodySize
  },
  stage: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.lg
  },
  waveform: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 104,
    gap: 3
  },
  waveBar: {
    width: 5,
    borderRadius: 3
  },
  stateLabel: {
    color: colors.textPrimary,
    fontSize: 16,
    fontWeight: '600'
  },
  transcript: {
    maxHeight: 120,
    alignSelf: 'stretch'
  },
  transcriptContent: {
    paddingHorizontal: spacing.md
  },
  transcriptText: {
    color: colors.textSecondary,
    fontSize: typography.bodySize,
    textAlign: 'center',
    lineHeight: 20
  },
  controls: {
    alignItems: 'center',
    paddingBottom: spacing.xl,
    gap: spacing.md
  },
  modeToggle: {
    flexDirection: 'row',
    backgroundColor: colors.bgPanel,
    borderRadius: radii.button,
    padding: 2
  },
  modeOption: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xs,
    borderRadius: radii.button
  },
  modeOptionActive: {
    backgroundColor: colors.bgRaised
  },
  modeText: {
    color: colors.textSecondary,
    fontSize: typography.bodySize
  },
  modeTextActive: {
    color: colors.textPrimary,
    fontWeight: '600'
  },
  talkButton: {
    width: 88,
    height: 88,
    borderRadius: 44,
    backgroundColor: colors.bgRaised,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    alignItems: 'center',
    justifyContent: 'center'
  },
  talkButtonActive: {
    backgroundColor: colors.accentBlue,
    borderColor: colors.accentBlue
  },
  talkHint: {
    color: colors.textMuted,
    fontSize: typography.metaSize
  }
})
