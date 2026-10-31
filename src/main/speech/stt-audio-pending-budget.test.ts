import { describe, expect, it, vi } from 'vitest'
vi.mock('node:worker_threads', async () => ({
  Worker: (await import('./stt-audio-test-worker')).SttAudioTestWorker
}))
vi.mock('./stt-worker-paths', () => ({
  getSttWorkerPath: () => '',
  getSherpaModulePath: () => ''
}))
vi.mock('./model-catalog', () => ({
  getCatalogModel: (id: string) => ({
    id,
    provider: id === 'cloud' ? 'openai' : 'local',
    type: 'transducer',
    streaming: true,
    sampleRate: 16000,
    files: []
  })
}))
vi.mock('./openai-api-key-store', () => ({ readOpenAiSpeechApiKey: () => '' }))
vi.mock('./openai-transcription-client', () => ({
  OpenAiTranscriptionSession: class {
    feedAudio = vi.fn()
    async finish() {
      return ''
    }
  }
}))
vi.mock('./model-manager', () => ({
  ModelManager: class {
    async getModelState() {
      return { status: 'ready' }
    }
    getModelDir() {
      return ''
    }
  }
}))
import { MockWorker, service, start, samples, stop } from './stt-audio-pending-test-fixture'
import {
  MAX_PENDING_STT_AUDIO_BYTES as LIMIT,
  MAX_PENDING_STT_AUDIO_FRAMES as FRAMES
} from './stt-audio-pending-budget'

describe('speech worker pending audio', () => {
  it('fences synchronous feed and repeated stop inside the overflow error sink', async () => {
    const subject = service()
    const reentrant = samples(4)
    let errorCount = 0
    let reentrantStop: Promise<void> | undefined
    await subject.startDictation('local', (event) => {
      if (event.type === 'error') {
        errorCount += 1
        subject.feedAudio(reentrant, 16000)
        reentrantStop = subject.stopDictation()
      }
    })
    const worker = MockWorker.instances.at(-1)!
    subject.feedAudio(samples(), 16000)
    subject.feedAudio(samples(4), 16000)
    expect(errorCount).toBe(1)
    expect(reentrant.byteLength).toBe(4)
    expect(worker.messages.filter((message) => message.type === 'feed')).toHaveLength(1)
    expect(worker.messages.filter((message) => message.type === 'stop')).toHaveLength(1)
    worker.ack(0)
    stop(worker)
    await reentrantStop
  })
  it('reports one explicit error, enters stopping and keeps prior admitted audio', async () => {
    const { subject, worker, events } = await start()
    const first = samples()
    first[0] = 12
    subject.feedAudio(first, 16000)
    const overflow = samples(4)
    subject.feedAudio(overflow, 16000)
    subject.feedAudio(samples(4), 16000)
    expect(first.byteLength).toBe(0)
    expect(overflow.byteLength).toBe(4)
    expect(events.filter((event) => event.type === 'error')).toHaveLength(1)
    expect(worker.messages.filter((message) => message.type === 'stop')).toHaveLength(1)
    expect(worker.messages.find((message) => message.type === 'feed')?.samples?.[0]).toBe(12)
    worker.ack(0)
    stop(worker)
    await subject.stopDictation()
    expect(events.filter((event) => event.type === 'stopped')).toHaveLength(1)
    expect(events.some((event) => event.type === 'audio-consumed')).toBe(false)
  })
  it('counts full transferred backing allocation for small views', async () => {
    const { subject, worker } = await start()
    subject.feedAudio(new Float32Array(new ArrayBuffer(LIMIT), 0, 1), 16000)
    subject.feedAudio(samples(4), 16000)
    expect(worker.messages.filter((message) => message.type === 'feed')).toHaveLength(1)
    stop(worker)
  })
  it('ignores duplicate, stale, fractional and future ACKs', async () => {
    const { subject, worker } = await start()
    subject.feedAudio(samples(LIMIT / 2), 16000)
    worker.ack(0)
    subject.feedAudio(samples(), 16000)
    worker.ack(0)
    for (const [byteEnd, frameEnd] of [
      [-1, 1],
      [LIMIT * 10, 2],
      [LIMIT, 100],
      [LIMIT + 0.5, 2]
    ]) {
      worker.emit('message', { type: 'audio-consumed', byteEnd, frameEnd })
    }
    subject.feedAudio(samples(4), 16000)
    expect(worker.messages.filter((message) => message.type === 'feed')).toHaveLength(2)
    stop(worker)
  })
  it('releases ACKed credit and preserves watermark across warm reuse', async () => {
    const { subject, worker } = await start()
    subject.feedAudio(samples(), 16000)
    worker.ack(0)
    const pending = subject.stopDictation()
    stop(worker)
    await pending
    await subject.startDictation('local', () => {})
    subject.feedAudio(samples(), 16000)
    worker.ack(0)
    subject.feedAudio(samples(4), 16000)
    expect(MockWorker.instances).toHaveLength(1)
    expect(worker.messages.filter((message) => message.type === 'feed')).toHaveLength(2)
    worker.ack(1)
    stop(worker)
  })
  it('does not reset unconsumed credit on a stopped/warm transition', async () => {
    const { subject, worker } = await start()
    subject.feedAudio(samples(), 16000)
    const pending = subject.stopDictation()
    stop(worker)
    await pending
    await subject.startDictation('local', () => {})
    subject.feedAudio(samples(4), 16000)
    expect(worker.messages.filter((message) => message.type === 'feed')).toHaveLength(1)
    worker.ack(0)
    stop(worker)
  })
  it('retains old-worker debt through timeout and ignores wrong-worker ACKs', async () => {
    vi.useFakeTimers()
    const { subject, worker: oldWorker } = await start()
    const termination = Promise.withResolvers<number>()
    oldWorker.pendingTermination = termination.promise
    subject.feedAudio(samples(), 16000)
    const pending = subject.stopDictation()
    await vi.advanceTimersByTimeAsync(60_000)
    await pending
    const events: string[] = []
    await subject.startDictation('local', (event) => events.push(event.type))
    const replacement = MockWorker.instances.at(-1)!
    replacement.emit('message', { type: 'audio-consumed', byteEnd: LIMIT, frameEnd: 1 })
    subject.feedAudio(samples(4), 16000)
    expect(replacement.messages.some((message) => message.type === 'feed')).toBe(false)
    expect(events).toContain('error')
    expect(oldWorker.terminated).toBe(true)
    stop(replacement)
    termination.resolve(1)
    await Promise.resolve()
  })
  it('releases old credit only after old ACK or confirmed termination', async () => {
    vi.useFakeTimers()
    const { subject, worker: oldWorker } = await start()
    const termination = Promise.withResolvers<number>()
    oldWorker.pendingTermination = termination.promise
    subject.feedAudio(samples(), 16000)
    const pending = subject.stopDictation()
    await vi.advanceTimersByTimeAsync(60_000)
    await pending
    oldWorker.ack(0)
    await subject.startDictation('local', () => {})
    const replacement = MockWorker.instances.at(-1)!
    subject.feedAudio(samples(), 16000)
    termination.resolve(1)
    await Promise.resolve()
    oldWorker.emit('message', { type: 'audio-consumed', byteEnd: LIMIT, frameEnd: 1 })
    subject.feedAudio(samples(4), 16000)
    expect(replacement.messages.filter((message) => message.type === 'feed')).toHaveLength(1)
    stop(replacement)
  })
  it('reclaims unconsumed credit on confirmed termination without an ACK', async () => {
    vi.useFakeTimers()
    const { subject, worker: oldWorker } = await start()
    const termination = Promise.withResolvers<number>()
    oldWorker.pendingTermination = termination.promise
    subject.feedAudio(samples(), 16000)
    const pending = subject.stopDictation()
    await vi.advanceTimersByTimeAsync(60_000)
    await pending
    termination.resolve(1)
    await Promise.resolve()
    await subject.startDictation('local', () => {})
    const replacement = MockWorker.instances.at(-1)!
    subject.feedAudio(samples(), 16000)
    expect(replacement.messages.filter((message) => message.type === 'feed')).toHaveLength(1)
  })
  it('keeps debt after failed termination until the old worker actually exits', async () => {
    vi.useFakeTimers()
    const { subject, worker: oldWorker } = await start()
    const termination = Promise.withResolvers<number>()
    oldWorker.pendingTermination = termination.promise
    subject.feedAudio(samples(), 16000)
    const pending = subject.stopDictation()
    await vi.advanceTimersByTimeAsync(60_000)
    await pending
    termination.reject(new Error('termination incomplete'))
    await Promise.resolve()
    oldWorker.emit('exit', 1)
    await subject.startDictation('local', () => {})
    const replacement = MockWorker.instances.at(-1)!
    subject.feedAudio(samples(), 16000)
    expect(replacement.messages.filter((message) => message.type === 'feed')).toHaveLength(1)
  })
  it('rolls back credit when postMessage throws before transfer', async () => {
    const { subject, worker } = await start()
    worker.throwNext = true
    const first = samples()
    expect(() => subject.feedAudio(first, 16000)).toThrow('post failed')
    expect(first.byteLength).toBe(LIMIT)
    expect(() => subject.feedAudio(first, 16000)).not.toThrow()
    expect(first.byteLength).toBe(0)
  })
  it('preserves owner mismatch and ownerless admission', async () => {
    const { subject, worker } = await start('owner')
    const first = samples()
    expect(() => subject.feedAudio(first, 16000, 'foreign')).toThrow('dictation_owner_mismatch')
    expect(first.byteLength).toBe(LIMIT)
    subject.feedAudio(first, 16000, 'owner')
    expect(first.byteLength).toBe(0)
    const pending = subject.stopDictation('owner')
    worker.ack(0)
    stop(worker)
    await pending
    const ownerless = samples(4)
    subject.feedAudio(ownerless, 16000, 'owner')
    expect(ownerless.byteLength).toBe(4)
  })
  it('leaves cloud feeds outside the local worker policy', async () => {
    const subject = service()
    const events: string[] = []
    await subject.startDictation('cloud', (event) => events.push(event.type))
    const first = samples(LIMIT * 2)
    subject.feedAudio(first, 16000)
    expect(first.byteLength).toBe(LIMIT * 2)
    expect(events).toEqual(['ready'])
    await subject.stopDictation()
  })
  it('bounds tiny frame count and omits empty audio without transfer', async () => {
    const { subject, worker } = await start()
    for (let i = 0; i < FRAMES; i++) {
      subject.feedAudio(samples(4), 16000)
    }
    const empty = new Float32Array(new ArrayBuffer(8), 0, 0)
    subject.feedAudio(empty, 16000)
    expect(empty.buffer.byteLength).toBe(8)
    subject.feedAudio(samples(4), 16000)
    expect(worker.messages.filter((message) => message.type === 'feed')).toHaveLength(FRAMES)
    stop(worker)
  })
})
