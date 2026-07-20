// Mesh TTS-back — the one thing native Orca voice does NOT provide. Voice
// INPUT (mic -> transcript -> terminal) is handled by Orca's native dictation
// (useMobileDictation + on-device Parakeet); we do not reimplement it. This
// module only synthesizes speech from text via the mesh Kokoro route so the
// agent/transcript can be spoken back through the phone.
// See plans/active/2026-07-20-orca-mobile-voice-pet-canvas.md.

// node-a LiteLLM (canonical audio path, fixed 2026-07-20). A3/settings can make
// this host-configurable.
export const MESH_VOICE_BASE_URL = 'http://100.92.56.51:4000'
const TTS_MODEL = 'mesh-tts-kokoro'
const TTS_VOICE = 'af_heart'
const PLAYBACK_SAMPLE_RATE = 16000
const KOKORO_SAMPLE_RATE = 24000

// Linear resample 16-bit LE mono PCM. Brings Kokoro's 24 kHz output down to the
// 16 kHz that expo-two-way-audio playback expects.
export function resamplePcm16le(input: Uint8Array, fromRate: number, toRate: number): Uint8Array {
  if (fromRate === toRate) {
    return input
  }
  const inSamples = Math.floor(input.byteLength / 2)
  const inView = new DataView(input.buffer, input.byteOffset, input.byteLength)
  const outSamples = Math.max(0, Math.floor((inSamples * toRate) / fromRate))
  const out = new Uint8Array(outSamples * 2)
  const outView = new DataView(out.buffer)
  const ratio = fromRate / toRate
  for (let i = 0; i < outSamples; i++) {
    const srcPos = i * ratio
    const idx = Math.floor(srcPos)
    const frac = srcPos - idx
    const s0 = inView.getInt16(idx * 2, true)
    const s1 = idx + 1 < inSamples ? inView.getInt16((idx + 1) * 2, true) : s0
    outView.setInt16(i * 2, Math.round(s0 + (s1 - s0) * frac), true)
  }
  return out
}

// text -> mesh Kokoro -> 16 kHz 16-bit LE PCM ready for playPCMData.
export async function synthesizeViaMesh(text: string): Promise<Uint8Array> {
  const res = await fetch(`${MESH_VOICE_BASE_URL}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: TTS_MODEL,
      input: text,
      voice: TTS_VOICE,
      response_format: 'pcm'
    })
  })
  if (!res.ok) {
    throw new Error(`TTS ${res.status}`)
  }
  const pcm24 = new Uint8Array(await res.arrayBuffer())
  return resamplePcm16le(pcm24, KOKORO_SAMPLE_RATE, PLAYBACK_SAMPLE_RATE)
}
