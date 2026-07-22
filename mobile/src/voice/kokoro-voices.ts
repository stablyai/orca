import AsyncStorage from '@react-native-async-storage/async-storage'
import { kokoroDirectBaseUrlFor } from './mesh-voice-endpoint'

// Which Kokoro voice the mesh speaks in. Fetched live from the TTS service so
// the list stays true to what is actually installed rather than drifting from a
// hardcoded copy — probed 2026-07-21, the Nord reaches it in ~400ms and the
// service reports 67 voices.
//
// Kokoro's own API, not LiteLLM: the :4000 proxy does not expose /audio/voices
// (verified — it 404s), so the catalogue comes straight from the backend while
// synthesis still goes through the canonical proxy. The hostname follows the
// selected HostProfile; see `mesh-voice-endpoint.ts` for the resolution rules
// and the single DEFAULT fallback.

export const DEFAULT_KOKORO_VOICE = 'af_heart'

const VOICE_STORAGE_KEY = 'orca:kokoroVoice'

// Kokoro encodes language and gender in the id prefix: <lang><gender>_<name>.
const LANGUAGE_LABELS: Record<string, string> = {
  a: 'American English',
  b: 'British English',
  e: 'Spanish',
  f: 'French',
  h: 'Hindi',
  i: 'Italian',
  j: 'Japanese',
  p: 'Portuguese',
  z: 'Chinese'
}

export type KokoroVoice = {
  id: string
  /** Name with the prefix stripped and capitalised, e.g. `af_heart` -> "Heart". */
  label: string
  language: string
  gender: 'female' | 'male' | 'unknown'
}

export function describeVoiceId(id: string): KokoroVoice {
  const [prefix, ...rest] = id.split('_')
  const name = rest.join('_') || id
  const language = LANGUAGE_LABELS[prefix?.[0] ?? ''] ?? 'Other'
  const genderChar = prefix?.[1]
  return {
    id,
    label: name.charAt(0).toUpperCase() + name.slice(1),
    language,
    gender: genderChar === 'f' ? 'female' : genderChar === 'm' ? 'male' : 'unknown'
  }
}

/**
 * Voices to fall back on when the catalogue cannot be fetched — a small, known
 * spread rather than the whole list, so an offline settings screen still offers
 * a real choice instead of an empty picker.
 */
export const FALLBACK_VOICE_IDS = [
  'af_heart',
  'af_bella',
  'af_nicole',
  'am_michael',
  'am_onyx',
  'bf_emma',
  'bm_george'
]

export async function fetchKokoroVoices(
  hostEndpoint?: string | null,
  signal?: AbortSignal
): Promise<KokoroVoice[]> {
  try {
    const res = await fetch(`${kokoroDirectBaseUrlFor(hostEndpoint)}/v1/audio/voices`, { signal })
    if (!res.ok) {
      throw new Error(`voices ${res.status}`)
    }
    const body = (await res.json()) as { voices?: ({ id?: string } | string)[] }
    const ids = (body.voices ?? [])
      .map((entry) => (typeof entry === 'string' ? entry : entry.id))
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
    if (ids.length === 0) {
      throw new Error('voices list empty')
    }
    return ids.map(describeVoiceId)
  } catch {
    // Why swallow: a settings screen that cannot reach the mesh should still let
    // the operator pick from known-good voices, not show an error and nothing.
    return FALLBACK_VOICE_IDS.map(describeVoiceId)
  }
}

// Why a module-level cache: synthesizeViaMesh runs on the speech path and must
// not await AsyncStorage mid-utterance. Primed once at startup and updated on
// every save, so the stored choice applies without a read on each turn.
let cachedVoice: string = DEFAULT_KOKORO_VOICE

export function currentKokoroVoice(): string {
  return cachedVoice
}

export async function loadKokoroVoice(): Promise<string> {
  try {
    const stored = await AsyncStorage.getItem(VOICE_STORAGE_KEY)
    if (stored) {
      cachedVoice = stored
    }
  } catch {
    // Keep the default; an unreadable preference must not break speech.
  }
  return cachedVoice
}

export async function saveKokoroVoice(voiceId: string): Promise<void> {
  cachedVoice = voiceId
  try {
    await AsyncStorage.setItem(VOICE_STORAGE_KEY, voiceId)
  } catch {
    // The in-memory cache already applies to this run; losing only persistence
    // is not worth failing the interaction.
  }
}

/** Speak a short sample so the operator can hear a voice before committing. */
export function voicePreviewText(voice: KokoroVoice): string {
  return `Hi, I'm ${voice.label}. This is how I'll read your replies.`
}
