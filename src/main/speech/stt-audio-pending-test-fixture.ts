import { afterEach, vi } from 'vitest'
import { SttAudioTestWorker as MockWorker } from './stt-audio-test-worker'
import { ModelManager } from './model-manager'
import { SttService } from './stt-service'
import { MAX_PENDING_STT_AUDIO_BYTES as LIMIT } from './stt-audio-pending-budget'

export function service(): SttService {
  return new SttService(new ModelManager())
}
export async function start(owner = 'desktop') {
  const subject = service()
  const events: { type: string; error?: string }[] = []
  await subject.startDictation('local', (event) => events.push(event), undefined, owner)
  const worker = MockWorker.instances.at(-1)!
  return { subject, worker, events }
}
export function samples(bytes = LIMIT) {
  return new Float32Array(bytes / 4)
}
export function stop(worker: InstanceType<typeof MockWorker>) {
  worker.emit('message', { type: 'stopped' })
}
afterEach(() => {
  for (const worker of MockWorker.instances) {
    worker.emit('exit', 0)
  }
  MockWorker.instances.length = 0
  vi.useRealTimers()
})

export { MockWorker }
