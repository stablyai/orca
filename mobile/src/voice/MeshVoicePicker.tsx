import React from 'react'
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from 'react-native'
import { Check, Play } from 'lucide-react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import {
  DEFAULT_KOKORO_VOICE,
  fetchKokoroVoices,
  loadKokoroVoice,
  saveKokoroVoice,
  voicePreviewText,
  type KokoroVoice
} from './kokoro-voices'
import { useMeshSpeak } from './use-mesh-speak'

// Picks the Kokoro voice the MESH speaks in — distinct from the "Speech Model"
// section above it, which selects the on-device model that transcribes YOU.
// Input and output are different halves of the pipeline and different services.

export function MeshVoicePicker({
  hostEndpoint
}: { hostEndpoint?: string | null } = {}): React.JSX.Element {
  const [voices, setVoices] = React.useState<KokoroVoice[] | null>(null)
  const [selected, setSelected] = React.useState(DEFAULT_KOKORO_VOICE)
  const { speak, isSpeaking } = useMeshSpeak({ hostEndpoint })

  React.useEffect(() => {
    const controller = new AbortController()
    let cancelled = false
    void (async () => {
      const [list, stored] = await Promise.all([
        fetchKokoroVoices(hostEndpoint ?? null, controller.signal),
        loadKokoroVoice()
      ])
      if (!cancelled) {
        setVoices(list)
        setSelected(stored)
      }
    })()
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [hostEndpoint])

  const choose = React.useCallback(
    (voice: KokoroVoice) => {
      setSelected(voice.id)
      void saveKokoroVoice(voice.id)
      // Why speak on selection: a voice name is meaningless on a list. Hearing
      // it is the entire point of choosing one, and it doubles as a live check
      // that mesh TTS still reaches the speaker.
      speak(voicePreviewText(voice))
    },
    [speak]
  )

  // Group by language so 67 voices read as a short list of familiar sections
  // rather than one undifferentiated wall of ids.
  const grouped = React.useMemo(() => {
    const map = new Map<string, KokoroVoice[]>()
    for (const voice of voices ?? []) {
      const bucket = map.get(voice.language) ?? []
      bucket.push(voice)
      map.set(voice.language, bucket)
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [voices])

  if (voices === null) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator size="small" color={colors.textSecondary} />
      </View>
    )
  }

  return (
    <View>
      <Text style={styles.hint}>
        The voice the mesh speaks replies in. Tap to hear it.
        {isSpeaking ? ' Playing…' : ''}
      </Text>
      {grouped.map(([language, entries]) => (
        <View key={language} style={styles.group}>
          <Text style={styles.groupTitle}>{language}</Text>
          {entries.map((voice) => {
            const active = voice.id === selected
            return (
              <Pressable
                key={voice.id}
                onPress={() => choose(voice)}
                style={[styles.row, active && styles.rowActive]}
                accessibilityRole="radio"
                accessibilityState={{ selected: active }}
                accessibilityLabel={`${voice.label}, ${voice.gender}, ${language}`}
              >
                {active ? (
                  <Check size={16} color={colors.textPrimary} strokeWidth={2.4} />
                ) : (
                  <Play size={14} color={colors.textMuted} strokeWidth={2} />
                )}
                <Text style={[styles.rowLabel, active && styles.rowLabelActive]}>
                  {voice.label}
                </Text>
                <Text style={styles.rowMeta}>
                  {voice.gender === 'unknown' ? voice.id : voice.gender}
                </Text>
              </Pressable>
            )
          })}
        </View>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  loading: { paddingVertical: spacing.lg, alignItems: 'center' },
  hint: {
    fontSize: typography.metaSize,
    color: colors.textMuted,
    marginBottom: spacing.sm
  },
  group: { marginBottom: spacing.md },
  groupTitle: {
    fontSize: typography.metaSize,
    color: colors.textMuted,
    textTransform: 'uppercase',
    marginBottom: spacing.xs
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radii.card,
    backgroundColor: colors.bgPanel,
    marginBottom: 2
  },
  rowActive: { backgroundColor: colors.bgRaised },
  rowLabel: { flex: 1, fontSize: typography.bodySize, color: colors.textSecondary },
  rowLabelActive: { color: colors.textPrimary },
  rowMeta: { fontSize: typography.metaSize, color: colors.textMuted }
})
