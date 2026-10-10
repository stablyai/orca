import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { CloudSpeechProviderId } from '../../shared/cloud-speech-providers'
import { createCloudSpeechSession } from './cloud-speech-session-factory'
import { verifyCloudSpeechApiKey } from './cloud-speech-key-verification'
import { getCatalogModel } from './model-catalog'

// Opt-in: ORCA_REAL_SPEECH_PROVIDER_TEST=1 ORCA_REAL_SPEECH_AUDIO=<16 kHz mono PCM16 WAV of speech>
// plus <PROVIDER>_API_KEY env vars (e.g. SONIOX_API_KEY). Bills the provider a few seconds of audio.
const enabled = process.env.ORCA_REAL_SPEECH_PROVIDER_TEST === '1'
const audioPath = process.env.ORCA_REAL_SPEECH_AUDIO ?? ''

const CASES: { modelId: string; provider: CloudSpeechProviderId }[] = [
  { modelId: 'soniox-stt-rt-v5', provider: 'soniox' },
  { modelId: 'elevenlabs-scribe-v2-realtime', provider: 'elevenlabs' },
  { modelId: 'elevenlabs-scribe-v2', provider: 'elevenlabs' },
  { modelId: 'deepgram-nova-3', provider: 'deepgram' },
  { modelId: 'gemini-2.5-flash', provider: 'gemini' },
  { modelId: 'groq-whisper-large-v3-turbo', provider: 'groq' },
  { modelId: 'mistral-voxtral-mini', provider: 'mistral' },
  { modelId: 'openai-gpt-4o-mini-transcribe', provider: 'openai' }
]

function envKey(provider: CloudSpeechProviderId): string | undefined {
  return process.env[`${provider.toUpperCase()}_API_KEY`]
}

function readWavSamples(path: string): Float32Array {
  const wav = readFileSync(path)
  const start = wav.indexOf('data') + 8
  const samples = new Float32Array(Math.floor((wav.length - start) / 2))
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = wav.readInt16LE(start + i * 2) / 32768
  }
  return samples
}

describe.skipIf(!enabled || !existsSync(audioPath))('cloud speech providers (real API)', () => {
  for (const { modelId, provider } of CASES) {
    const apiKey = envKey(provider)
    it.skipIf(!apiKey)(`${modelId} transcribes speech`, { timeout: 60_000 }, async () => {
      const key = apiKey ?? ''
      expect(await verifyCloudSpeechApiKey(provider, key)).toEqual({ ok: true, message: null })
      const manifest = getCatalogModel(modelId)
      if (!manifest) {
        throw new Error(`missing ${modelId}`)
      }
      const errors: string[] = []
      const session = createCloudSpeechSession(manifest, {
        readApiKey: () => key,
        sink: (event) => {
          if (event.type === 'error') {
            errors.push(event.error ?? '')
          }
        }
      })
      const samples = readWavSamples(audioPath)
      for (let i = 0; i < samples.length; i += 8000) {
        session.feedAudio(samples.slice(i, i + 8000), 16_000)
        if (manifest.realtime) {
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
      }
      const text = await session.finish()
      expect(errors).toEqual([])
      expect(text.length).toBeGreaterThan(3)
    })
  }
})
