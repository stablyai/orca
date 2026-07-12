import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { SttEvent } from './stt-service-types'
import { SonioxTranscriptionSession } from './soniox-transcription-client'

const apiKey = process.env.SONIOX_API_KEY
const pcmPath = process.env.SONIOX_SMOKE_PCM_PATH

describe.skipIf(!apiKey || !pcmPath)('Soniox live transcription smoke', () => {
  it('streams a billable 16 kHz mono PCM fixture and receives final speech', async () => {
    const events: SttEvent[] = []
    const session = new SonioxTranscriptionSession(
      'soniox-stt-rt-v5',
      () => apiKey!,
      (event) => events.push(event)
    )
    await session.start()

    const pcm = readFileSync(pcmPath!)
    const bytesPer100Ms = 3200
    for (let offset = 0; offset < pcm.length; offset += bytesPer100Ms) {
      const chunk = pcm.subarray(offset, Math.min(offset + bytesPer100Ms, pcm.length))
      const samples = new Float32Array(Math.floor(chunk.length / 2))
      for (let index = 0; index < samples.length; index += 1) {
        samples[index] = chunk.readInt16LE(index * 2) / 32768
      }
      session.feedAudio(samples, 16000)
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    await session.finish()

    expect(events.filter((event) => event.type === 'error')).toEqual([])
    expect(events.some((event) => event.type === 'final' && Boolean(event.text?.trim()))).toBe(true)
  }, 120_000)
})
