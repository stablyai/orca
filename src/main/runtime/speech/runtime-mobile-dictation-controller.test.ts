import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultVoiceSettings } from '../../../shared/constants'
import {
  setSpeechServiceFactories,
  type SpeechServiceFactories
} from '../../speech/speech-runtime-service'
import { MOBILE_DICTATION_RECONNECT_GRACE_MS } from '../../../shared/rpc-contract/speech-params'
import { RuntimeMobileDictationController } from './runtime-mobile-dictation-controller'
import type { RuntimeStore } from '../construction/runtime-store-contract'

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
const textSoFar = {
  text: 'before the drop',
  revision: 1,
  committed: 'before the drop',
  tentative: ''
}

describe('mobile dictation text so far', () => {
  it('numbers each change and keeps committed text apart from text the engine may still revise', async () => {
    const controller = await startPhoneDictation()
    sink({ type: 'partial', text: 'and then' })
    expect(controller.feed(chunk)).toEqual({
      dictationId: 'd-1',
      text: 'before the drop and then',
      revision: 2,
      committed: 'before the drop',
      tentative: 'and then'
    })
    sink({ type: 'final', text: 'and then some' })
    expect(controller.feed(chunk)).toEqual({
      dictationId: 'd-1',
      text: 'before the drop and then some',
      revision: 3,
      committed: 'before the drop and then some',
      tentative: ''
    })
  })
})

describe('mobile dictation across a phone reconnect', () => {
  it('keeps the session while the phone keeps reaching it, whatever connection it uses', async () => {
    const controller = await startPhoneDictation()

    await vi.advanceTimersByTimeAsync(MOBILE_DICTATION_RECONNECT_GRACE_MS - 1)
    expect(controller.feed(chunk)).toEqual({ dictationId: 'd-1', ...textSoFar })
    expect(controller.feed(chunk)).toEqual({ dictationId: 'd-1' })
    // A reply carrying the text may be lost at a drop, so it is sent again a second later.
    await vi.advanceTimersByTimeAsync(1000)
    expect(controller.feed(chunk)).toEqual({ dictationId: 'd-1', ...textSoFar })
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

describe('mobile dictation on several phones', () => {
  it('keeps each phone in its own dictation at the same time', async () => {
    const controller = await startPhoneDictation()

    await controller.start({ dictationId: 'd-1', modelId: 'test-model', clientId: 'phone-b' })
    sink({ type: 'final', text: 'from phone b' })

    await expect(controller.finish({ dictationId: 'd-1', clientId: 'phone-b' })).resolves.toEqual({
      dictationId: 'd-1',
      text: 'from phone b'
    })
    await expect(controller.finish({ dictationId: 'd-1', clientId: 'phone-a' })).resolves.toEqual({
      dictationId: 'd-1',
      text: 'before the drop'
    })
  })
})
