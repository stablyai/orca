import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { View, Text, StyleSheet, Pressable, ScrollView } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { ChevronLeft, Mic, Square } from 'lucide-react-native'
import { playPCMData, useExpoTwoWayAudioEventListener } from '@orca/expo-two-way-audio'
import { loadHosts } from '../src/transport/host-store'
import { useAllHostClients } from '../src/transport/client-context'
import { useMobileDictation } from '../src/hooks/use-mobile-dictation'
import { synthesizeViaMesh } from '../src/voice/mesh-voice-turn'
import { colors, radii, spacing, typography } from '../src/theme/mobile-theme'

// A2: the live voice turn. Input is Orca's NATIVE dictation
// (useMobileDictation -> on-device Parakeet -> transcript); we do not
// reimplement STT or terminal inject. Our only addition is TTS-back — speaking
// the transcript aloud via the mesh Kokoro route, which native Orca voice does
// not do. See plans/active/2026-07-20-orca-mobile-voice-pet-canvas.md.

type TalkMode = 'hold' | 'toggle'

const WAVE_BARS = 32

export default function VoiceScreen(): React.JSX.Element {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const [mode, setMode] = useState<TalkMode>('hold')
  const [levels, setLevels] = useState<number[]>(() => Array.from({ length: WAVE_BARS }, () => 0))
  const [transcript, setTranscript] = useState<string>('')
  const [speaking, setSpeaking] = useState(false)
  const speakingRef = useRef(false)
  speakingRef.current = speaking
  const speakTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [hostIds, setHostIds] = useState<string[]>([])
  useEffect(() => {
    loadHosts()
      .then((hs) => setHostIds(hs.map((h) => h.id)))
      .catch(() => {
        // no hosts is fine; dictation stays disabled until one connects
      })
  }, [])
  const clients = useAllHostClients(hostIds)
  const primaryClient = useMemo(
    () => clients.find((c) => c.state === 'connected')?.client ?? null,
    [clients]
  )

  const speakBack = useCallback((text: string) => {
    if (!text) {
      return
    }
    setSpeaking(true)
    synthesizeViaMesh(text)
      .then((pcm16) => {
        // eslint-disable-next-line no-console
        console.log('[voice] tts pcm16 bytes', pcm16.byteLength)
        playPCMData(pcm16)
        const ms = (pcm16.byteLength / 2 / 16000) * 1000
        speakTimer.current = setTimeout(() => setSpeaking(false), Math.min(ms + 500, 30000))
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.log('[voice] tts error', String(err))
        setSpeaking(false)
      })
  }, [])

  const [noSpeech, setNoSpeech] = useState(false)
  const dictation = useMobileDictation({
    client: primaryClient,
    enabled: primaryClient !== null && !speaking,
    onTranscript: (text) => {
      const clean = text.trim()
      if (!clean) {
        setNoSpeech(true)
        return
      }
      setTranscript(clean)
      speakBack(clean)
    },
    onError: (err) => {
      // "no speech" is a normal empty result, not a failure — keep it gentle.
      if (/no speech/i.test(err.message)) {
        setNoSpeech(true)
      } else {
        setTranscript(err.message)
      }
    }
  })

  useEffect(() => {
    return () => {
      if (speakTimer.current) {
        clearTimeout(speakTimer.current)
      }
    }
  }, [])

  const pushLevel = useCallback((raw: number) => {
    const v = Math.max(0, Math.min(1, raw))
    setLevels((prev) => {
      const next = prev.slice(1)
      next.push(v)
      return next
    })
  }, [])
  const isRecordingRef = useRef(false)
  isRecordingRef.current = dictation.isRecording
  // Waveform: mic level while dictating, playback level while speaking.
  useExpoTwoWayAudioEventListener('onInputVolumeLevelData', (event) => {
    if (isRecordingRef.current) {
      pushLevel(event.data)
    }
  })
  useExpoTwoWayAudioEventListener('onOutputVolumeLevelData', (event) => {
    if (speakingRef.current) {
      pushLevel(event.data)
    }
  })

  const startTalk = useCallback(() => {
    if (!primaryClient || speaking) {
      return
    }
    setTranscript('')
    setNoSpeech(false)
    void dictation.start()
  }, [primaryClient, speaking, dictation])
  const stopTalk = useCallback(() => {
    if (dictation.isRecording) {
      setLevels(Array.from({ length: WAVE_BARS }, () => 0))
      void dictation.stop()
    }
  }, [dictation])

  const onTalkPress = useCallback(() => {
    if (mode !== 'toggle') {
      return
    }
    if (dictation.isRecording) {
      stopTalk()
    } else {
      startTalk()
    }
  }, [mode, dictation.isRecording, startTalk, stopTalk])

  const stateLabel = useMemo(() => {
    if (speaking) {
      return 'Speaking…'
    }
    if (noSpeech) {
      return 'No speech — tap to talk'
    }
    switch (dictation.status) {
      case 'starting':
        return 'Starting…'
      case 'recording':
        return 'Listening…'
      case 'processing':
        return 'Transcribing…'
      case 'error':
        return 'Something went wrong'
      default:
        return primaryClient ? 'Tap to talk' : 'Connect a desktop to talk'
    }
  }, [speaking, noSpeech, dictation.status, primaryClient])

  const isActive = dictation.isRecording || speaking
  const isBusy = dictation.isProcessing || dictation.isStarting || speaking
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
        <Text style={styles.targetLabel}>Input</Text>
        <View style={styles.targetChip}>
          <Text style={styles.targetChipText}>Orca dictation · speak-back on</Text>
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
                  backgroundColor: isActive ? colors.accentBlue : colors.borderSubtle
                }
              ]}
            />
          ))}
        </View>
        <Text style={styles.stateLabel}>{stateLabel}</Text>
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
          style={[styles.talkButton, dictation.isRecording && styles.talkButtonActive]}
          onPress={onTalkPress}
          onPressIn={mode === 'hold' && !isBusy ? startTalk : undefined}
          onPressOut={mode === 'hold' ? stopTalk : undefined}
          disabled={!primaryClient || (isBusy && !dictation.isRecording)}
          accessibilityLabel={dictation.isRecording ? 'Stop talking' : 'Talk'}
        >
          {dictation.isRecording ? (
            <Square size={30} color={colors.onAccent} fill={colors.onAccent} />
          ) : (
            <Mic size={34} color={primaryClient ? colors.textPrimary : colors.textMuted} />
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
