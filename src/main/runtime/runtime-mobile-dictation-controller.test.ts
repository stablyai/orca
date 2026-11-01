import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultVoiceSettings } from '../../shared/constants'
import {
  setSpeechServiceFactories,
  type SpeechServiceFactories
} from '../speech/speech-runtime-service'
import { MOBILE_DICTATION_RECONNECT_GRACE_MS } from '../../shared/rpc-contract/speech-params'
import { RuntimeMobileDictationController } from './runtime-mobile-dictation-controller'
import type { RuntimeStore } from './runtime-store-contract'

type Sink = (event: { type: string; text?: string }) => void

let sink: Sink = () => {}
// A finish transcribes what was said; tests that never settle it model a slow transcription.
let transcription: Promise<void> = Promise.resolve()
const stopDictation = vi.fn(async (_owner: string, options?: { discard?: boolean }) => {
  if (!options?.discard) {
    await transcription
  }
})
const feedAudio = vi.fn()

beforeEach(() => {
  vi.useFakeTimers()
  stopDictation.mockClear()
  transcription = Promise.resolve()
  feedAudio.mockClear()
  const factories = {
    createModelManager: () => ({ getModelState: async () => ({ status: 'ready' }) }),
    createSttService: () => ({
      startDictation: async (_modelId: string, next: Sink) => {
        sink = next
      },
      feedAudio,
      stopDictation
    })
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the controller calls only getModelState, startDictation, feedAudio and stopDictation.
  setSpeechServiceFactories(factories as unknown as SpeechServiceFactories)
})

afterEach(() => {
  setSpeechServiceFactories(null)
  vi.useRealTimers()
})

async function startPhoneDictation(): Promise<RuntimeMobileDictationController> {
  const store = { getSettings: () => ({ voice: { ...getDefaultVoiceSettings(), enabled: true } }) }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the controller reads only getSettings.
  const controller = new RuntimeMobileDictationController(() => store as unknown as RuntimeStore)
  await controller.start({ dictationId: 'd-1', modelId: 'test-model', clientId: 'phone-a' })
  sink({ type: 'final', text: 'before the drop' })
  return controller
}

const chunk = { dictationId: 'd-1', audioBase64: 'AAAA', sampleRate: 16_000, clientId: 'phone-a' }

describe('mobile dictation across a phone reconnect', () => {
  it('keeps the session while the phone keeps reaching it, whatever connection it uses', async () => {
    const controller = await startPhoneDictation()

    await vi.advanceTimersByTimeAsync(MOBILE_DICTATION_RECONNECT_GRACE_MS - 1)
    expect(controller.feed(chunk)).toEqual({ dictationId: 'd-1', text: 'before the drop' })
    expect(controller.feed(chunk)).toEqual({ dictationId: 'd-1' })
    // A reply carrying the text may be lost at a drop, so it is sent again a second later.
    await vi.advanceTimersByTimeAsync(1000)
    expect(controller.feed(chunk)).toEqual({ dictationId: 'd-1', text: 'before the drop' })
    await vi.advanceTimersByTimeAsync(MOBILE_DICTATION_RECONNECT_GRACE_MS - 1)
    sink({ type: 'final', text: 'after it' })

    await expect(controller.finish({ dictationId: 'd-1', clientId: 'phone-a' })).resolves.toEqual({
      dictationId: 'd-1',
      text: 'before the drop after it'
    })
  })

  it('releases the speech model when the phone goes quiet for the grace', async () => {
    const controller = await startPhoneDictation()
    transcription = new Promise(() => {})

    await vi.advanceTimersByTimeAsync(MOBILE_DICTATION_RECONNECT_GRACE_MS)

    expect(stopDictation).toHaveBeenCalledOnce()
    expect(() => controller.feed(chunk)).toThrow('dictation_stream_not_started')
  })

  it('feeds resent audio once and in the order it was spoken', async () => {
    const controller = await startPhoneDictation()
    const spoken = (seq: number) => ({
      ...chunk,
      seq,
      audioBase64: Buffer.from(Int16Array.of(seq).buffer).toString('base64')
    })

    // 1 is resent after 2 overtook it; 0 and 1 arrive twice; 3 never comes.
    for (const seq of [0, 2, 0, 1, 1, 4]) {
      controller.feed(spoken(seq))
    }
    await controller.finish({ dictationId: 'd-1', clientId: 'phone-a' })

    const fed = feedAudio.mock.calls.map(([samples]) => Math.round(samples[0] * 32768))
    expect(fed).toEqual([0, 1, 2, 4])
  })

  // 35s of speech, or more tiny chunks than 30s of native microphone events, is more than a reconnect holds back.
  it.each([
    { held: 'long chunks', count: 7, audioBase64: Buffer.alloc(160_000).toString('base64') },
    { held: 'tiny chunks', count: 1001, audioBase64: 'AAA=' }
  ])('stops waiting for a chunk that never comes behind $held', async ({ count, audioBase64 }) => {
    const controller = await startPhoneDictation()

    for (let seq = 1; seq <= count; seq += 1) {
      controller.feed({ ...chunk, audioBase64, seq })
    }

    expect(feedAudio).toHaveBeenCalledTimes(count)
  })
  it('gives up on as many gaps as it takes to stay within what a reconnect holds back', async () => {
    const controller = await startPhoneDictation()
    const fiveSeconds = Buffer.alloc(160_000).toString('base64')

    // Every other chunk is missing: ten tiny ones, then ten of five seconds each.
    for (let index = 0; index < 20; index += 1) {
      const audioBase64 = index < 10 ? 'AAA=' : fiveSeconds
      controller.feed({ ...chunk, audioBase64, seq: 2 * index + 1 })
    }

    // At most five 5s chunks stay held under the 30s cap.
    expect(feedAudio).toHaveBeenCalledTimes(15)
  })
})

describe('mobile dictation cancel', () => {
  it('lets the phone start again right after it cancels', async () => {
    const controller = await startPhoneDictation()
    transcription = new Promise(() => {})

    await controller.cancel({ dictationId: 'd-1', clientId: 'phone-a' })

    await expect(
      controller.start({ dictationId: 'd-2', modelId: 'test-model', clientId: 'phone-a' })
    ).resolves.toEqual({ dictationId: 'd-2', modelId: 'test-model', dedupesResentChunks: true })
  })
})
